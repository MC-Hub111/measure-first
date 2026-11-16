#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
git init -q
git config user.email "eval@example.com"
git config user.name "Eval"
git add parser.py README.md
git commit -qm "Initial parser"
mv parser_fixed.py parser.py
