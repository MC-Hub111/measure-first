// G4 validity on a real transcript, with the haystack the hook actually keeps:
// CUMULATIVE tool output + all prompts SO FAR (never the future).
import { distinctiveNumbers, isSourced } from './_logic.mjs'
import fs from 'node:fs'; import readline from 'node:readline'

const textOf = c => typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text??'').join('\n'):''
const resultText = c => !Array.isArray(c)?'':c.filter(b=>b?.type==='tool_result').map(b=>{
  const r=b.content; return typeof r==='string'?r:Array.isArray(r)?r.map(x=>x?.text??'').join('\n'):''}).join('\n')

const turns=[]; let cur=null; let hay=''
const rl=readline.createInterface({input:fs.createReadStream(process.argv[2]),crlfDelay:Infinity})
for await (const line of rl){
  let d; try{d=JSON.parse(line)}catch{continue}
  if(d.isSidechain) continue
  const t=d.type,c=(d.message??{}).content
  if(t==='user'){
    if(Array.isArray(c)&&c.some(b=>b?.type==='tool_result')){ hay+='\n'+resultText(c); continue }
    const txt=textOf(c)
    if(cur){ cur.hay=hay; turns.push(cur) }
    hay+='\n'+txt
    cur={answer:'',hay:'',interrupted:txt.trim().startsWith('[Request interrupted')}
  } else if(t==='assistant'&&cur){ const x=textOf(c); if(x.trim()) cur.answer=x }
}
if(cur){ cur.hay=hay; turns.push(cur) }

const real=turns.filter(t=>t.answer.trim()&&!t.interrupted)
const g4 = (ans,h) => distinctiveNumbers(ans).filter(tok=>!isSourced(tok,h))

let flagged=0, nums=0; const detail=[]
for(const [i,t] of real.entries()){
  const loose=g4(t.answer,t.hay)
  if(loose.length){ flagged++; nums+=loose.length; detail.push({i,nums:loose,
    ctx:loose.slice(0,3).map(tok=>{const k=t.answer.indexOf(tok);return t.answer.slice(Math.max(0,k-50),k+tok.length+30).replace(/\s+/g,' ')})}) }
}
console.log('=== PRECISION: how often does G4 fire on real work? ===')
console.log(`answers considered        ${real.length}`)
console.log(`answers flagged           ${flagged}  (${(100*flagged/real.length).toFixed(1)}%)`)
console.log(`numbers flagged           ${nums}`)

// ---- RECALL: plant a number that exists nowhere, in every real answer ----
let caught=0, planted=0
for(const t of real){
  const fake = '7' + String(100000 + (planted*7919)%800000)   // 7xxxxxx, not in any output
  if (t.hay.includes(fake) || t.answer.includes(fake)) continue
  planted++
  const spiked = t.answer + `\n\nThe measured value was ${fake}.`
  if (g4(spiked,t.hay).includes(fake)) caught++
}
console.log('\n=== RECALL: a fabricated number planted in each real answer ===')
console.log(`planted ${planted}  caught ${caught}  (${(100*caught/planted).toFixed(1)}%)`)

console.log('\n=== every surviving flag, for adjudication ===')
for(const d of detail) for(const [j,n] of d.nums.entries())
  console.log(`  t${String(d.i).padStart(3)}  ${n.padEnd(11)} ${d.ctx[j]??''}`)
