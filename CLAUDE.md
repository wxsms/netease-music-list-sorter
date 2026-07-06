# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project-Specific Guidelines

This project is a PD (Prefill-Decode) disaggregated routing layer for LLM inference. Supports vLLM and SGLang backends.

### Project Structure

```
llm_v1/                  # Main Python source, normally we work under this directory if not specify
  common/                # Config, args, base64, ops queue
  core/                  # Core constants and models
  infrastructure/        # etcd, ZMQ, HTTP, TCP utilities
  kv_tree/               # KV cache tracking (hash trees, indexers)
  load_balancer/         # Random, round-robin, cache-aware LB policies
  metrics/               # Prometheus metrics collection and export
  entry_vllm/            # vLLM router + worker
  entry_sglang/          # SGLang router + worker + endpoint
  tests/                 # pytest test suite
  configs/disagg.yaml    # Default config
docker/                  # Dockerfiles and build scripts
vllm/                    # vllm git submodule (patched)
sglang/                  # sglang git submodule (patched)
lmcache/                 # lmcache git submodule (patched)
```

### Submodule Code Lookup

When investigating issues related to specific submodules, search in the corresponding directory:
- **vllm** questions → search in `vllm/`
- **sglang** questions → search in `sglang/`
- **lmcache** questions → search in `lmcache/`

**IMPORTANT:** The built-in Grep tool systematically returns no results inside git submodule directories (sglang/, vllm/, lmcache/) because ripgrep skips gitlink entries. Always use `Bash` with `grep -rn` to search content inside submodules. The Grep tool is fine for the main project directory (llm_v1/, etc.).

### Running

Note that you should have a local etcd running before start any component.

```bash
# if the container already exist
podman start etcd

# otherwise, run a new container
podman run -d --name etcd -p 2379:2379 -p 2380:2380 -e ALLOW_NONE_AUTHENTICATION=yes -e ETCD_ADVERTISE_CLIENT_URLS=http://0.0.0.0:2379 hub-mirror.wps.cn/kas-open/bitnami/etcd:3.5.21-debian-12-r1
```

```bash
# Router
python llm_v1/router.py --namespace test --worker-type Router --config-path llm_v1/configs/disagg.yaml

# Workers
python llm_v1/worker.py --namespace test --worker-type VllmDecodeWorker --config-path llm_v1/configs/disagg.yaml
python llm_v1/worker.py --namespace test --worker-type VllmPrefillWorker --config-path llm_v1/configs/disagg.yaml
```

### Shell Environment

All agent operations (search, grep, find, etc.) must use bash/Unix commands. **Do NOT use PowerShell commands** (e.g., no `Get-ChildItem`, `Select-String`, `Get-Content`, `Remove-Item`, etc.). Always use Unix equivalents (`ls`, `grep`, `cat`, `rm`, etc.) and Unix path conventions (forward slashes `/`, `/dev/null` not `NUL`).

### Git

No need to `cd` into the repo directory before running git commands — run git directly.

### Testing

```bash
cd llm_v1 && python -m pytest tests/ --cov=. --cov-report=term-missing -v
```

- Config: `llm_v1/pytest.ini`
- Tests: `llm_v1/tests/`
- External deps (vllm, sglang, pyetcd, netifaces, prometheus_client) are mocked in `conftest.py` via `sys.modules`
- zmq and msgspec are NOT mocked (must be installed locally)

When writing new tests, make sure not to cheat, and write valuable test!
