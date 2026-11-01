# paged-ml-host

The local generative-image host (Tier B): a small native sidecar that serves a
loopback-only HTTP API (`/api/ml/*`) and runs image jobs through **your own build
of the [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
command-line program**, one child process per job, against **model files you
installed**. The editor reaches it through its same-origin proxy; `paged-node`
calls it directly.

What it does not do:

- It never opens an outbound network connection.
- It never bundles, downloads, builds or fetches stable-diffusion.cpp or any model
  weights. You install both; the host only runs the binary you point it at.
- It refuses a model configuration whose licence you have not acknowledged.

## Licence gate

The intended model, **Qwen-Image-2.1** (GGUF), is published under the **Qwen
Research License**. paged does not redistribute it. You download it yourself,
read and accept its licence, and say so in the config with
`"licenceAcknowledged": true`. A model entry without it is refused with
`409 licence_not_acknowledged`, and the host is not `ready` until it is
acknowledged. The same applies to any other model you configure: its weights
are yours, under their own licence. See [`NOTICE`](./NOTICE).

## Install stable-diffusion.cpp (your step)

Build it from source for your GPU. The build options change between releases,
so check the project's own README for the version you check out; the general
shape is:

```bash
git clone --recursive https://github.com/leejet/stable-diffusion.cpp
cd stable-diffusion.cpp
# Pick ONE backend (option names vary by version):
cmake -B build -DSD_METAL=ON      # Apple Silicon (Metal)
cmake -B build -DSD_VULKAN=ON     # Vulkan (AMD, Intel, NVIDIA)
cmake -B build -DSD_CUDA=ON       # NVIDIA CUDA
cmake -B build                    # CPU only
cmake --build build --config Release
```

The CLI ends up under `build/bin/`. It is called `sd` in older releases and
`sd-cli` in newer ones. Check that it runs (`build/bin/sd-cli --help`) and note
its absolute path. Qwen-Image needs a recent build; if a flag the host passes is
unknown to your build, update it.

## Run

```bash
cd apps/ml-host
cargo run --release --bin paged-ml-host -- [--port 7861] [--config <file>] [--sd <path>] [--allow-origin <origin>]...
```

- Binds `127.0.0.1` only. Default port `7861` (`--port`, env `PAGED_ML_HOST_PORT`);
  `--port 0` picks a free port.
- On start it prints `paged-ml-host listening on http://127.0.0.1:<port>` (the real
  port), which scripts and tests parse.
- `--config <file>` (env `PAGED_ML_HOST_CONFIG`; default
  `<platform config dir>/paged/ml-host.json`: `~/Library/Application Support` on
  macOS, `$XDG_CONFIG_HOME` or `~/.config` on Linux, `%APPDATA%` on Windows).
- `--sd <path>` overrides the config's `sdBinary`. With neither, the host looks for
  `sd-cli` on `PATH` (not a bare `sd`, which is often an unrelated tool).
- `--allow-origin <origin>` accepts browser requests from a non-loopback origin
  (repeatable). Loopback origins (`http://localhost:*`, `http://127.0.0.1:*`,
  `http://[::1]:*`) are always accepted.

Job files live in `<temp>/paged-ml-host-<pid>-<n>/` and are removed when the host
exits (Ctrl-C, SIGTERM) or a finished job is evicted (the last 32 are kept).

## Point it at your model files

```bash
curl -X PUT http://127.0.0.1:7861/api/ml/config -H 'Content-Type: application/json' -d '{
  "sdBinary": "/abs/path/to/stable-diffusion.cpp/build/bin/sd-cli",
  "model": {
    "id": "qwen-image-2.1",
    "licenceId": "qwen-research",
    "licenceAcknowledged": true,
    "diffusionModel": "/abs/path/qwen-image-2.1-<quant>.gguf",
    "textEncoder": "/abs/path/<text-encoder>.gguf",
    "vae": "/abs/path/<vae>.safetensors"
  },
  "extraArgs": ["--offload-to-cpu"]
}'
curl http://127.0.0.1:7861/api/ml/health
```

Every path must exist (`400 missing_file` names the field otherwise). The text
encoder is passed with `--llm` unless the model sets `"textEncoderFlag"` (older
builds used another flag name). `extraArgs` are appended to every invocation:
the place for sampler, flow-shift, memory or flash-attention options your build
and model want.

## API (v1)

Errors are JSON `{"error": "<code>", "message": "<text>"}`. Field names are
camelCase. Requests whose `Host` is not loopback get `403 forbidden_host` (DNS
rebinding); an `Origin` that is neither loopback nor allowed gets
`403 forbidden_origin`. Bodies are capped at 64 MiB (`413 too_large`).

| Route                          | What                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ml/health`           | `ok`, `version`, `api: 1`, `runtime {binary, found}`, `model {id, configured, licenceAcknowledged}`, `ready`, `capabilities` (`["generate","edit"]` when ready), `queue {running, queued}`                            |
| `GET /api/ml/config`           | The stored config                                                                                                                                                                                                     |
| `PUT /api/ml/config`           | Store and persist a config; `409 licence_not_acknowledged`, `400 missing_file`, `400 bad_request`                                                                                                                     |
| `POST /api/ml/jobs`            | `generate {prompt, negativePrompt?, width, height, steps?=20, seed?=-1, cfgScale?=2.5}` or `edit {prompt, image, mask?, references?(≤10), steps?, seed?, strength?=0.75}` (base64 PNGs) → `202 {id, state: "queued"}` |
| `GET /api/ml/jobs/{id}`        | `{id, kind, state, progress {step, total}, error?}`; `404 no_job`                                                                                                                                                     |
| `GET /api/ml/jobs/{id}/events` | Server-sent events: `state`, `progress`, then `done` / `failed` / `cancelled` with the job JSON, then the stream closes                                                                                               |
| `GET /api/ml/jobs/{id}/result` | `image/png` when done; `409 not_done`                                                                                                                                                                                 |
| `DELETE /api/ml/jobs/{id}`     | Cancel: kills the running process or drops a queued job; a finished job is unchanged                                                                                                                                  |

`POST /api/ml/jobs` answers `503 not_ready` (saying what is missing) until the
runtime is found and an acknowledged model is configured, and `400 bad_request`
for invalid input (no prompt, more than 10 references, bad base64 or not a PNG,
width/height not a multiple of 8 within 64..4096). One job runs at a time, in
FIFO order.

The invocation per job:

```
<sdBinary> --diffusion-model <dm> --vae <vae> <textEncoderFlag> <te>
  -p <prompt> [-n <negative>] -W <w> -H <h> --steps <n> -s <seed> --cfg-scale <c>
  -o <job dir>/out.png
  [edit with mask:    -i image.png --mask mask.png --strength <s>]
  [edit without mask: -r image.png]
  [each reference:    -r ref_<k>.png]
  <extraArgs...>
```

Progress comes from sd's progress-bar lines (`|====>   | 3/20 - 1.2s/it`); exit 0
with `out.png` written is `done`, anything else `failed` with sd's last output
lines in `error`.

## Development

```bash
cd apps/ml-host
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run
cargo deny check
```

The tests start the host in-process on an ephemeral port and drive a fake `sd`
(a shell script written at test time), so they need no GPU, runtime, model or
network. CI: `.github/workflows/ml-host.yml`. Moon project: `ml-host`.

## Licence

AGPL-3.0-only OR the Paged Media Enterprise License; see
[`LICENSE.md`](./LICENSE.md) and [`NOTICE`](./NOTICE).
