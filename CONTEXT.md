# linear-t3

Watches Linear for issues that match per-project filters and starts a T3 Code thread for each one.

## Language

**Daemon**:
The long-running process that polls Linear and launches threads.
_Avoid_: service, worker, bot

**Integration**:
An external system linear-t3 connects to with a token, either T3 Code or Linear.
_Avoid_: service, provider, connection

**Config**:
The user-edited settings: which T3 projects exist, their Linear teams and filters, and how their threads start.
_Avoid_: settings file, ecosystem

**Credentials**:
The saved tokens for each Integration. They're kept apart from the Config so the Config can be shared.
_Avoid_: env, secrets file

**State**:
The Daemon's record of which Linear issues already have a thread, so a restart never launches the same issue twice.
_Avoid_: cache, database
