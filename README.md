<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img alt="Duarte Santos: I build the apps I wish existed, mostly openGym" src="assets/banner-light.svg" width="100%">
</picture>

hey, I'm Duarte. I'm doing my apprenticeship as an application developer at Sunrise, near Zurich.

This summer every gym tracker I tried wanted a subscription, an account or my training data on someone else's server, usually all three. So I wrote a small page for exactly one user (me) and put it on my own server. Every awkward tap at the squat rack became that evening's fix.

Then friends wanted in, I open-sourced it, and three months later that page is **[openGym](https://github.com/DuarteSantos8/openGym)**: an iPhone and Apple Watch app, an Android app, a self-hosted web app in 19 languages, and a Discord full of people telling me what's broken. I'm still the first user of every release.

<a href="https://github.com/DuarteSantos8/openGym/stargazers"><img src="https://img.shields.io/github/stars/DuarteSantos8/openGym?style=flat-square&logo=github&label=stars&color=32d74b&labelColor=16181c" alt="Stars"></a>
<a href="https://github.com/DuarteSantos8/openGym/releases"><img src="https://img.shields.io/github/downloads/DuarteSantos8/openGym/total?style=flat-square&label=APK%20downloads&color=32d74b&labelColor=16181c" alt="Downloads"></a>
<a href="https://apps.apple.com/app/id6822275400"><img src="https://img.shields.io/badge/App%20Store-iPhone%20%2B%20Watch-32d74b?style=flat-square&logo=apple&logoColor=white&labelColor=16181c" alt="App Store"></a>
<a href="https://discord.gg/e62jY6fwVb"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Finvites%2Fe62jY6fwVb%3Fwith_counts%3Dtrue&query=%24.approximate_member_count&suffix=%20members&label=discord&logo=discord&logoColor=white&color=5865F2&labelColor=16181c&style=flat-square" alt="Discord members"></a>

```
$ git log --oneline --author=duarte openGym

2026-10-26  halloween theme. there's a skeleton on the muscle map now
2026-10-23  in the App Store, after Apple sent it back twice
2026-10-09  new exercise database, a few thousand animations
2026-07-20  open-sourced under the AGPL
2026-07-18  first commit, back when it was called "GymLog"
```

I build it with Claude Code. I decide what goes in, review it, and test every release on a staging server and on my own phone before it ships.

### other stuff

[AgentDeck](https://github.com/DuarteSantos8/agentdeck) exists because I run coding agents for hours and kept losing them whenever a browser tab closed. Now every session lives in tmux and nothing dies.

[attitude](https://duartesantos8.github.io/attitude/) is the orientation test from pilot screening, in the browser. Read the plane's attitude, steer with WASD.

Everything runs on one Proxmox server at home. It used to crash under load, so a Raspberry Pi now watches it and pulls the plug (an actual smart plug) when it stops answering. Most reliable thing I've built, and also the dumbest.

I also build websites for small Swiss businesses, like [litho.ch](https://litho.ch).

Mostly React, Node, Capacitor and Docker. Java, Python and Vue for school.

[duarte-santos.ch](https://duarte-santos.ch) · [opengym.ch](https://opengym.ch) · [discord](https://discord.gg/e62jY6fwVb)
