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
  `http://[::1]:*`, and their `https` forms) are always accepted.

### The access token

Every route but `GET /api/ml/health` needs the access token of this launch:
`Authorization: Bearer <token>`, `401 unauthorized` without it. Reaching the
loopback port is not enough to drive the host.

- At start the host generates a token and writes it, readable by you alone, to
  `<config file stem>.token` beside the config (`ml-host.token` beside the default
  `ml-host.json`); it prints the path and removes the file when it exits. Two hosts
  sharing one config file share that path: the later one's token is the file's.
- A launcher may supply the token instead in `PAGED_ML_HOST_TOKEN` (32 to 512
  characters of `A-Z a-z 0-9 - _ . ~`); then no file is written.
- The editor's dev proxy and `paged-node` present it for you. They read
  `PAGED_ML_HOST_TOKEN`, else the file named by `PAGED_ML_HOST_TOKEN_FILE`, else the
  token file beside `PAGED_ML_HOST_CONFIG` or the default config.

### The programs the host runs

What the host executes, and with which arguments, is yours to set in the config
file or on the command line, never over HTTP: `sdBinary`, `extraArgs`,
`matting.binary` and `matting.args`. `PUT /api/ml/config` keeps the stored value
of each when the request leaves it out, accepts the stored value (and `--sd`'s
path for `sdBinary`) unchanged, and refuses any other with `403 program_locked`.
Edit the config file and restart the host to change them.

Job files live in `<temp>/paged-ml-host-<pid>-<n>/` and are removed when the host
exits (Ctrl-C, SIGTERM) or a finished job is evicted (the last 32 are kept).

## Point it at your model files

Write the config file (`--config`, above), then start the host:

```json
{
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
}
```

```bash
curl http://127.0.0.1:7861/api/ml/health
```

The model block can also be set while the host runs (the editor's Settings ▸
Models does), with the access token:

```bash
curl -X PUT http://127.0.0.1:7861/api/ml/config \
  -H "Authorization: Bearer $(cat "<config dir>/paged/ml-host.token")" \
  -H 'Content-Type: application/json' -d '{ "model": { … } }'
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
`403 forbidden_origin`, as does a browser request that names no `Origin` and is
not same-origin (`Sec-Fetch-Site`). Every route but `GET /api/ml/health` needs
the access token (`401 unauthorized`). Bodies are capped at 64 MiB (`413 too_large`).

| Route                          | What                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ml/health`           | `ok`, `version`, `api: 1`, `runtime {binary, found}`, `model {id, configured, licenceAcknowledged}`, `ready`, `matting {id, configured, licenceAcknowledged, ready}`, `capabilities` (`generate` and `edit` when ready, `matting` when the matting runner is), `queue {running, queued}` |
| `GET /api/ml/config`           | The stored config                                                                                                                                                                                                                                                                        |
| `PUT /api/ml/config`           | Store and persist a config; `403 program_locked`, `409 licence_not_acknowledged`, `400 missing_file`                                                                                                                                                                                     |
| `POST /api/ml/jobs`            | `generate {prompt, negativePrompt?, width, height, steps?=20, seed?=-1, cfgScale?=2.5}`, `edit {prompt, image, mask?, references?(≤10), steps?, seed?, strength?=0.75}` or `matting {image}` (base64 PNGs) → `202 {id, state: "queued"}`                                                 |
| `GET /api/ml/jobs/{id}`        | `{id, kind, state, progress {step, total}, error?}`; `404 no_job`                                                                                                                                                                                                                        |
| `GET /api/ml/jobs/{id}/events` | Server-sent events: `state`, `progress`, then `done` / `failed` / `cancelled` with the job JSON, then the stream closes                                                                                                                                                                  |
| `GET /api/ml/jobs/{id}/result` | `image/png` when done; `409 not_done`                                                                                                                                                                                                                                                    |
| `DELETE /api/ml/jobs/{id}`     | Cancel: kills the running process or drops a queued job; a finished job is unchanged                                                                                                                                                                                                     |

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

## A matting runner (`ml.matting@1`)

Remove background (`media.paged.image/remove-background`) can use a matting model you installed,
run by a program you installed: the host runs it like sd, one job at a time, and never fetches
either. Name it in the config file (merged with the rest of it); the API cannot set
its `binary` or `args`:

```json
"matting": {
  "id": "my-matting-model",
  "licenceId": "<its licence>",
  "licenceAcknowledged": true,
  "binary": "/abs/path/to/your/matting-cli",
  "model": "/abs/path/to/the/model/file",
  "args": ["--model", "{model}", "{input}", "{output}"]
}
```

`{input}` is the picture (PNG), `{output}` the PNG the program writes: a cut-out with alpha, or a
greyscale matte (white = foreground). `args` defaults to `{input} {output}`. The licence gate and
the file checks are the generative model's. While the runner is ready, `health.capabilities` lists
`matting`, and the editor's `supports("ml.matting@1")` follows. A failed run reports the program's
last output lines as the job's `error`.

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
