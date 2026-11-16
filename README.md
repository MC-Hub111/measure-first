# measure-first

*By Martin Cohen, Australia. MIT licence.*

A Claude Code mod that makes sure Claude has actually run a check before it tells
you the result. It stops test commands whose pass or fail result gets lost, stops
staging of files nobody has looked at, and leaves you a short note when an answer
says "nothing uses this", quotes a number, or says the tests are green with
nothing behind it.

The full description, what it runs and stores, and the measurements are in
[plugin/README.md](plugin/README.md). It collects nothing and sends nothing: see
[Privacy](plugin/PRIVACY.md).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install measure-first --marketplace MC-Hub111/measure-first
```

Answer `y` to add the marketplace, then choose a scope. In the desktop app: click +
next to the prompt box, then Plugins, Add marketplace with
`MC-Hub111/measure-first`, then Add plugin.

## What is in this repository

| folder | what it holds |
|---|---|
| `plugin/` | the mod itself. This is all that gets installed. |
| `dev/` | unit cases, transcript replay harnesses and with/without eval cases. See [dev/README.md](dev/README.md). |
