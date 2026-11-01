# linear-t3

Watches Linear for issues that match a project's filters and starts a T3 Code thread for each one.

## Language

**Daemon**:
The process that polls Linear and launches threads for one T3 project. It keeps polling until stopped, or polls once when asked.
_Avoid_: service, worker, bot

**Integration**:
An external system linear-t3 connects to with a token: T3 Code or Linear.
_Avoid_: service, connection

**Config**:
The user's choices: which T3 project to watch, which Linear issues to pick up, how their threads start, and how many may run at once. A run's Config is assembled from the CLI, the Local Config and the Global Config, with T3's own settings filling the gaps.
_Avoid_: settings file, ecosystem

**Global Config**:
The Config the user keeps for every repository on this machine, such as the T3 address and the thread cap.
_Avoid_: user config, home config

**Local Config**:
The Config kept with a repository: which T3 project and Linear team to watch, and which issues to pick up there.
_Avoid_: project config, repo config

**Credentials**:
The saved tokens for each Integration. They're kept apart from the Config so the Config can be shared.
_Avoid_: env, secrets file

**Provider**:
A T3 agent backend that a thread runs on, such as Claude, Codex or Pi. Each Provider offers its own models, and the same model can be available through more than one Provider.
_Avoid_: harness, engine

**Model alias**:
A short name T3 accepts for a model, like `opus-5.5`.
_Avoid_: nickname, shorthand

**Running thread**:
Any T3 thread that is doing work right now: its agent is mid-turn, still finishing up, or still has background tasks running. It counts whether the Daemon or the user started it. A thread waiting for the user's approval or input doesn't count. Running threads are what the thread cap limits.
_Avoid_: active thread, busy thread, open thread

**Thread cap**:
The most Running threads T3 may have before the Daemon stops launching new ones.
_Avoid_: concurrency limit, max threads

**State**:
The record of which Linear issues already have a thread, and which launch actions are still unfinished. It keeps restarts from launching the same issue twice.
_Avoid_: cache, database
