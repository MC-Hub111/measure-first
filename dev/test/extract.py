#!/usr/bin/env python3
"""Extract the guards' logic FROM hooks/register.ts so the test runs the shipped
text, not a copy of it. A test against a retyped copy proves nothing about what
ships. Writes test/_logic.mjs, which test/guards.test.mjs imports.

    python3 dev/test/extract.py, then node dev/test/guards.test.mjs
"""
import re, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
src = (ROOT / "plugin" / "hooks" / "register.ts").read_text()
body = src[src.index("/** Commands whose exit code"):src.index("export const register")]
body = re.sub(r"\)\s*:\s*(?:string\[\]|string|boolean|number)\s*\{", ") {", body)
body = re.sub(r"(\w+):\s*(?:string\[\]|string|boolean|number)(?=\s*[),=])", r"\1", body)
body = re.sub(r"const out:\s*string\[\]\s*=", "const out =", body)

leftover = [l for l in body.splitlines() if re.search(r":\s*(?:string|boolean|number)\b", l)]
if leftover:
    sys.exit("type annotations the stripper missed:\n  " + "\n  ".join(leftover))

names = ["GATE", "SWALLOW", "SEARCH", "ABSENCE", "GREEN", "ESCAPE", "segments",
         "staleStatusRead", "needsPipefail", "distinctiveNumbers", "isSourced",
         "commandOf", "hasGate", "isGateCommand", "GATE_WORD", "claimText", "sweepingAdd"]
(HERE / "_logic.mjs").write_text(body + "\nexport {" + ", ".join(names) + "}\n")
print(f"extracted {len(body)} chars from plugin/hooks/register.ts")
