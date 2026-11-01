# linear-t3

Watches Linear for issues that match a project's filters and starts a T3 Code thread for each one.

This glossary describes the accepted target design in the [parameter-driven CLI project](https://linear.app/provorov/project/run-linear-t3-with-layered-config-and-cli-parameters-bb70c64bd978). Implementation status is tracked there.

## Language

**Daemon**:
The process that polls Linear and launches threads for one T3 project. It keeps polling until stopped, or performs a single poll when requested. Several Daemons can watch the same project with different Config.
_Avoid_: service, worker, bot

**Integration**:
An external system linear-t3 connects to with a token, either T3 Code or Linear.
_Avoid_: service, provider, connection

**Config**:
The user's choices: which T3 project to watch, its Linear team and filters, how its threads start, and how many may run at once. These choices can be saved or supplied for one invocation.
_Avoid_: settings file, ecosystem

**Credentials**:
The saved tokens for each Integration. They're kept apart from the Config so the Config can be shared.
_Avoid_: env, secrets file

**Running thread**:
Any T3 thread that is doing work right now: its agent is mid-turn, still finishing up, or still has background tasks running. It counts whether the Daemon or the user started it. A thread waiting for the user's approval or input doesn't count. Running threads are what the thread caps limit.
_Avoid_: active thread, busy thread, open thread

**State**:
The shared record of which Linear issues already have a thread and which launch actions remain unfinished. Concurrent Daemons and restarts use it to avoid launching the same issue twice.
_Avoid_: cache, database

**Watcher cap**:
The maximum number of Running threads launched by one Daemon invocation. Each new invocation has its own allowance.
_Avoid_: named watcher limit

**Shared cap**:
The maximum number of Running threads across a T3 server or within one T3 project. Threads launched by any Daemon or by the user count toward it.
_Avoid_: per-process limit
