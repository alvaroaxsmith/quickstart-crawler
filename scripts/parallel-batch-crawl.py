#!/usr/bin/env python3
"""
Orquestrador de crawl em batches com rotação de perfil Chrome.

Cada batch recebe um Chrome fresco (novo _pxvid) para evitar
o bloqueio PX por envenenamento de sessão.

Uso:
  python3 scripts/parallel-batch-crawl.py [--urls /tmp/urls-interleaved.json]
                                           [--batch-size 20]
                                           [--workers 3]
                                           [--output /tmp/batch-enrich-v2]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from queue import Empty, Queue
from threading import Thread

# ─── Configuração padrão ──────────────────────────────────────────────────────
CRAWLER   = str(Path(__file__).parent.parent / "dist/cli/index.js")
CHROME    = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ORIGINAL  = "/Users/alvaromachadoferreira/workspace/crawler-test/data/products_output.json"
BASE_PORT = 9222
CONCURRENCY = 2
TIMEOUT     = 60_000


# ─── Helpers CDP ──────────────────────────────────────────────────────────────

def wait_cdp(port: int, timeout: int = 15) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def prewarm_cdp(port: int) -> None:
    """Pré-navega via WebSocket nativo para inicializar o contexto CDP (fix Chrome 148)."""
    try:
        resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3)
        data = json.loads(resp.read())
        ws_url = data.get("webSocketDebuggerUrl", "")
        if not ws_url:
            return
        js = f"""
const ws = new WebSocket('{ws_url}')
ws.onopen = () => ws.send(JSON.stringify({{ id: 1, method: 'Target.getTargets' }}))
ws.onmessage = (e) => {{
  const msg = JSON.parse(e.data)
  if (msg.id === 1) {{
    const t = (msg.result?.targetInfos ?? []).find(t => t.type === 'page')
    if (t) ws.send(JSON.stringify({{ id: 2, method: 'Target.activateTarget', params: {{ targetId: t.targetId }} }}))
    else {{ ws.close(); process.exit(0) }}
  }}
  if (msg.id === 2) {{ ws.close(); process.exit(0) }}
}}
ws.onerror = () => process.exit(0)
setTimeout(() => {{ ws.close(); process.exit(0) }}, 3000)
"""
        subprocess.run(
            ["node", "--input-type=module"],
            input=js, capture_output=True, text=True, timeout=5
        )
        time.sleep(0.5)
    except Exception:
        pass  # não-fatal


def kill_chrome(port: int) -> None:
    subprocess.run(
        f"pkill -f 'remote-debugging-port={port}' 2>/dev/null || true",
        shell=True, capture_output=True
    )
    time.sleep(0.8)


def start_chrome(port: int, profile: str) -> None:
    kill_chrome(port)
    shutil.rmtree(profile, ignore_errors=True)
    subprocess.Popen(
        [
            CHROME,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--no-first-run", "--no-default-browser-check",
            "--no-startup-window", "--disable-sync",
            "--disable-extensions", "--disable-default-apps",
            "--window-size=1368,807", "--disable-notifications",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(3)


# ─── Worker ──────────────────────────────────────────────────────────────────

def worker(worker_id: int, batch_queue: Queue, results: list,
           output_base: str) -> None:
    port    = BASE_PORT + worker_id
    profile = f"/tmp/chrome-worker-{worker_id}"
    log_path = Path(f"{output_base}/logs/worker-{worker_id}.log")
    log_fh   = log_path.open("w")

    def log(msg: str) -> None:
        line = f"[W{worker_id}] {msg}"
        print(line, flush=True)
        log_fh.write(line + "\n")
        log_fh.flush()

    log(f"Iniciado | porta {port}")

    while True:
        try:
            batch_idx, batch_file = batch_queue.get_nowait()
        except Empty:
            break

        batch_name  = Path(batch_file).stem
        result_dir  = f"{output_base}/results/{batch_name}"
        done_marker = f"{output_base}/results/{batch_name}.done"

        if Path(done_marker).exists():
            log(f"→ {batch_name} já feito, pulando")
            batch_queue.task_done()
            continue

        urls = json.loads(Path(batch_file).read_text())
        log(f"→ {batch_name} ({len(urls)} URLs)")

        # Chrome fresco por batch
        log("Iniciando Chrome fresco...")
        start_chrome(port, profile)

        if not wait_cdp(port, timeout=15):
            log(f"✗ CDP na porta {port} não respondeu — pulando {batch_name}")
            kill_chrome(port)
            batch_queue.task_done()
            continue

        prewarm_cdp(port)
        log("Chrome CDP pronto, executando crawler...")

        Path(result_dir).mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "CDP_URL": f"http://127.0.0.1:{port}"}

        proc = subprocess.Popen(
            [
                "node", CRAWLER,
                "--input",       batch_file,
                "--output",      result_dir,
                "--concurrency", str(CONCURRENCY),
                "--timeout",     str(TIMEOUT),
            ],
            env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        for line in proc.stdout:
            log(line.rstrip())
        proc.wait()

        kill_chrome(port)
        Path(done_marker).touch()

        # Contabiliza resultado
        pf = Path(f"{result_dir}/products.json")
        if pf.exists():
            data  = json.loads(pf.read_text())
            prods = data.get("products", [])
            ok    = sum(1 for p in prods if p.get("status") == "success")
            log(f"✓ {batch_name}: {ok}/{len(prods)} sucesso")
            results.append((batch_name, ok, len(prods)))
        else:
            log(f"✗ {batch_name}: sem products.json gerado")
            results.append((batch_name, 0, 0))

        batch_queue.task_done()

    log("Todos os batches concluídos!")
    log_fh.close()


# ─── Merge final ──────────────────────────────────────────────────────────────

def merge_results(output_base: str) -> None:
    all_products: list = []
    for d in sorted(Path(f"{output_base}/results").glob("batch-*")):
        if not d.is_dir():
            continue
        pf = d / "products.json"
        if pf.exists():
            try:
                data = json.loads(pf.read_text())
                all_products.extend(data.get("products", []))
            except Exception as e:
                print(f"Erro ao ler {pf}: {e}")

    successes = [p for p in all_products if p.get("status") == "success"]
    total     = len(all_products)
    ok        = len(successes)
    pct       = ok * 100 // max(total, 1)
    print(f"\nTotal processado: {total} | Sucesso: {ok} ({pct}%)")

    # Merge com products_output.json original
    original     = json.loads(Path(ORIGINAL).read_text())
    enriched_map = {p["product_url"]: p for p in successes}

    result = []
    for prod in original:
        url = prod.get("product_url", "")
        if url in enriched_map:
            e    = enriched_map[url]
            prod = dict(prod)
            prod["normal_price"]   = e.get("normal_price")   or prod.get("normal_price")
            prod["discount_price"] = e.get("discount_price") or prod.get("discount_price")
        result.append(prod)

    enriched_count = sum(1 for p in result if p.get("normal_price"))
    output_path    = str(Path(ORIGINAL).parent / "products_output_enriched.json")
    json.dump(result, open(output_path, "w"), ensure_ascii=False, indent=2)
    print(f"products_output_enriched.json: {enriched_count}/{len(result)} enriquecidos")
    print(f"Salvo em {output_path}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls",       default="/tmp/urls-interleaved.json")
    ap.add_argument("--batch-size", type=int, default=20)
    ap.add_argument("--workers",    type=int, default=3)
    ap.add_argument("--output",     default="/tmp/batch-enrich-v2")
    args = ap.parse_args()

    output_base = args.output
    for d in ["batches", "results", "logs"]:
        Path(f"{output_base}/{d}").mkdir(parents=True, exist_ok=True)

    # Cria arquivos de batch
    urls    = json.loads(Path(args.urls).read_text())
    batches = [urls[i:i+args.batch_size] for i in range(0, len(urls), args.batch_size)]

    created = 0
    for i, batch in enumerate(batches):
        p = Path(f"{output_base}/batches/batch-{i:04d}.json")
        if not p.exists():
            p.write_text(json.dumps(batch))
            created += 1

    print(f"▶ {len(batches)} batches de ~{args.batch_size} URLs | "
          f"{created} criados | {args.workers} workers paralelos")
    est_min = (len(batches) // args.workers + 1) * 2
    print(f"  Estimativa: ~{est_min} min\n")

    # Monta a fila
    q: Queue = Queue()
    for i, b in enumerate(sorted(Path(f"{output_base}/batches").glob("batch-*.json"))):
        q.put((i, str(b)))

    # Lança workers
    results: list = []
    threads = [
        Thread(target=worker, args=(i, q, results, output_base), daemon=True)
        for i in range(args.workers)
    ]
    for t in threads:
        t.start()
        time.sleep(1)  # escalonamento suave para evitar corrida no Chrome

    for t in threads:
        t.join()

    # Merge final
    print("\n▶ Consolidando resultados...")
    merge_results(output_base)


if __name__ == "__main__":
    main()
