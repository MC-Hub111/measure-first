// G3 / G5 validity on a real transcript, using the shipped regexes and the
// per-turn `toolNames` the module actually builds — including its slice(0,40).
//
// G3/G5 are near-tautological under planting ("phrase present AND no search
// ran"), so planting measures nothing. What can fail, and is measured here:
//   A. fire rate on real answers, every hit printed for adjudication
//   B. PHRASE RECALL: real claims a wider net sees that the shipped regex misses
//   C. TRUNCATION BLIND SPOT: turns where a gate/search ran but is invisible
//      because toolNames keeps only the first 40 chars of the command
import {GATE, SEARCH, ABSENCE, GREEN, segments, hasGate, claimText} from './_logic.mjs'
import fs from 'node:fs'; import readline from 'node:readline'

const textOf = c => typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text??'').join('\n'):''
const uses = c => Array.isArray(c)?c.filter(b=>b?.type==='tool_use'):[]

// Wider nets, for recall only. Deliberately noisy: every extra hit is printed
// and adjudicated by hand rather than counted as a defect.
const WIDE_ABSENCE = /\b(?:no|not|zero|nothing|none|nowhere|never|without)\b[^.\n]{0,60}\b(?:exists?|used|call(?:s|ed|er|ers)?|referenc\w*|usages?|occurrences?|match\w*|mention\w*|import\w*|defin\w*|appears?|present|anywhere|in the (?:codebase|repo|repository|tree|project))/i
const WIDE_GREEN = /\b(?:all (?:\w+ ){0,2}(?:pass|green|clean)\w*|pass(?:es|ed|ing)? (?:cleanly|clean|green)|(?:went|came back|is|are|now) green|no (?:failures?|errors?|regressions?)|nothing (?:failed|broke)|clean sweep|fully (?:verified|green)|everything (?:passes|works|is green))/i

const turns=[]; let cur=null
const rl=readline.createInterface({input:fs.createReadStream(process.argv[2]),crlfDelay:Infinity})
for await (const line of rl){
  let d; try{d=JSON.parse(line)}catch{continue}
  if(d.isSidechain) continue
  const t=d.type, c=(d.message??{}).content
  if(t==='user'){
    if(Array.isArray(c)&&c.some(b=>b?.type==='tool_result')) continue
    const txt=textOf(c)
    if(cur) turns.push(cur)
    cur={answer:'',names:[],full:[],cmds:[],interrupted:txt.trim().startsWith('[Request interrupted')}
  } else if(t==='assistant'&&cur){
    const txt=textOf(c); if(txt.trim()) cur.answer=txt
    for(const u of uses(c)){
      if(u.name==='Bash'){
        const cmd=String(u.input?.command??'')
        cur.names.push('Bash:'+cmd.slice(0,40))   // exactly what the module stores
        cur.full.push('Bash:'+cmd)                 // the untruncated counterfactual
        cur.cmds.push(cmd)
      } else { cur.names.push(String(u.name)); cur.full.push(String(u.name)) }
    }
  }
}
if(cur) turns.push(cur)

const live=turns.filter(t=>t.answer.trim()&&!t.interrupted)
const searchedOf = s => /\b(Grep|Glob)\b/.test(s)||SEARCH.test(s)
const ranOf      = s => GATE.test(s)
// What the module does now: a gate must be RUN (command position), per segment.
const gateRan    = t => t.cmds.some(c => segments(c).some(seg => hasGate(seg)))

let g3=[], g5=[], absClaims=0, grnClaims=0
for(const [i,t] of live.entries()){
  // MUST match the module: it probes GATE/SEARCH against the WHOLE command at
  // tool.call time, not against the 40-char `toolNames`. Measuring the
  // truncated form here is how the first pass reported numbers for an object
  // the module had stopped being.
  const names=t.full.join(' ')
  const claims=claimText(t.answer)   // as the module does: quotes and code spans are not claims
  if(ABSENCE.test(claims)){ absClaims++
    if(!searchedOf(names)) g3.push([i,claims.match(ABSENCE)[0],names.slice(0,70)]) }
  if(GREEN.test(claims)){ grnClaims++
    if(!gateRan(t)) g5.push([i,claims.match(GREEN)[0],names.slice(0,70)]) }
}

console.log(`=== A. FIRE RATE on ${live.length} real answers ===`)
console.log(`G3  absence phrases present ${absClaims}   fired (no search ran) ${g3.length}  (${(100*g3.length/live.length).toFixed(1)}% of answers)`)
console.log(`G5  green   phrases present ${grnClaims}   fired (no gate ran)   ${g5.length}  (${(100*g5.length/live.length).toFixed(1)}% of answers)`)
for(const [label,list] of [['G3',g3],['G5',g5]]){
  console.log(`\n--- every ${label} fire, for adjudication ---`)
  if(!list.length) console.log('  (none)')
  for(const [i,m,n] of list) console.log(`  t${String(i).padStart(3)}  "${m}"\n        tools: ${n||'(none)'}`)
}

console.log(`\n=== B. PHRASE RECALL: claims a wider net sees that the shipped regex misses ===`)
for(const [label,narrow,wide] of [['G3',ABSENCE,WIDE_ABSENCE],['G5',GREEN,WIDE_GREEN]]){
  const missed=live.map((t,i)=>[i,t]).filter(([,t])=>wide.test(t.answer)&&!narrow.test(t.answer))
  const caught=live.filter(t=>wide.test(t.answer)&&narrow.test(t.answer)).length
  console.log(`\n${label}: wide net ${caught+missed.length}   shipped regex caught ${caught}   MISSED ${missed.length}`)
  for(const [i,t] of missed.slice(0,25)) console.log(`  t${String(i).padStart(3)}  ${JSON.stringify(t.answer.match(wide)[0].slice(0,90))}`)
  if(missed.length>25) console.log(`  … ${missed.length-25} more`)
}

console.log(`\n=== C. TRUNCATION BLIND SPOT (toolNames keeps 40 chars of each command) ===`)
let gateHidden=0, searchHidden=0, gateTurns=0, searchTurns=0
for(const t of live){
  const nm=t.names.join(' '), fl=t.full.join(' ')
  if(ranOf(fl)){ gateTurns++; if(!ranOf(nm)) gateHidden++ }
  if(searchedOf(fl)){ searchTurns++; if(!searchedOf(nm)) searchHidden++ }
}
console.log(`turns where a GATE ran:   ${gateTurns}   invisible to G5 after truncation: ${gateHidden}`)
console.log(`turns where a SEARCH ran: ${searchTurns}   invisible to G3 after truncation: ${searchHidden}`)
console.log(`\n=== D. would the fire rate change without truncation? ===`)
const g3b=live.filter(t=>ABSENCE.test(t.answer)&&!searchedOf(t.full.join(' '))).length
const g5b=live.filter(t=>GREEN.test(t.answer)&&!ranOf(t.full.join(' '))).length
console.log(`G3 fires: ${g3.length} truncated -> ${g3b} untruncated`)
console.log(`G5 fires: ${g5.length} truncated -> ${g5b} untruncated`)

// ---- E. which fix? full command over-matches too (`go`, `find` inside prose
// or paths). Variant: strip quoted strings and long paths before testing.
const bare = s => s.replace(/'[^']*'|"[^"]*"/g,' ').replace(/\/\S+/g,' ')
const stripped = t => t.full.map(x=>x.startsWith('Bash:')?'Bash:'+bare(x.slice(5)):x).join(' ')
console.log(`\n=== E. candidate fixes, fire counts ===`)
for(const [name,sel] of [['truncated 40 (shipped)',t=>t.names.join(' ')],
                         ['full command',t=>t.full.join(' ')],
                         ['full, quotes+paths stripped',stripped]]){
  const a=live.filter(t=>ABSENCE.test(t.answer)&&!searchedOf(sel(t))).length
  const b=live.filter(t=>GREEN.test(t.answer)&&!ranOf(sel(t))).length
  const gt=live.filter(t=>ranOf(sel(t))).length, st=live.filter(t=>searchedOf(sel(t))).length
  console.log(`  ${name.padEnd(30)} G3 fires ${String(a).padStart(2)}  G5 fires ${String(b).padStart(2)}   | turns seen as gate ${String(gt).padStart(3)}, as search ${String(st).padStart(3)}`)
}
console.log(`\n--- the G5 fires that SURVIVE the full-command fix (adjudicate these) ---`)
for(const [i,t] of live.map((t,i)=>[i,t]).filter(([,t])=>GREEN.test(t.answer)&&!ranOf(t.full.join(' '))))
  console.log(`  t${String(i).padStart(3)}  "${t.answer.match(GREEN)[0]}"  tools: ${t.full.join(' ').slice(0,100)}`)

console.log(`\n=== F. the G5 probe the module ships: gate in command position ===`)
console.log(`turns seen as gate: name anywhere in the command ${live.filter(t=>ranOf(t.full.join(' '))).length}   run in command position ${live.filter(gateRan).length}`)
const onlyNamed = live.map((t,i)=>[i,t]).filter(([,t])=>ranOf(t.full.join(' '))&&!gateRan(t))
console.log(`turns where a gate was only NAMED, never run: ${onlyNamed.length}; of those, answers claiming green: ${onlyNamed.filter(([,t])=>GREEN.test(t.answer)).length}`)
