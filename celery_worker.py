"""
celery_worker.py — Async Celery task workers for DHub PDF processing

Replaces synchronous execFile() calls from Node.js with async task dispatch.
Node.js sends tasks via Redis (LPUSH) and receives results via BLPOP.

Setup:
    pip install celery redis
    celery -A celery_worker worker --loglevel=info --concurrency=4

Environment variables:
    REDIS_URL       — Redis broker URL (default: redis://localhost:6379/0)
    CELERY_QUEUE    — Queue name (default: dhub_pdf_tasks)

Node.js integration:
    Instead of execFileAsync("python", ["pdf_parser.py", "redact", text]),
    use dispatchCeleryTask() in server-pdf-async.ts which pushes to Redis
    and polls for the result key.
"""

import os
import sys
import json
import time
import hashlib
import logging

from celery import Celery
from celery.utils.log import get_task_logger

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
CELERY_QUEUE = os.environ.get("CELERY_QUEUE", "dhub_pdf_tasks")

app = Celery(
    "dhub_workers",
    broker=REDIS_URL,
    backend=REDIS_URL,
)

app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=600,          # 10 minutes
    task_acks_late=True,         # Re-queue on worker crash
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,  # One task at a time per worker for fair distribution
    task_track_started=True,
    task_time_limit=300,         # 5 min hard limit
    task_soft_time_limit=240,    # 4 min soft limit (raises SoftTimeLimitExceeded)
)

logger = get_task_logger(__name__)

# ---------------------------------------------------------------------------
# Import pdf_parser functions
# ---------------------------------------------------------------------------
# Add project root to path so we can import pdf_parser
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from pdf_parser import handle_parse, handle_redact
    HAS_PDF_PARSER = True
except ImportError as e:
    logger.warning(f"pdf_parser not importable: {e}. Tasks will return error.")
    HAS_PDF_PARSER = False


# ---------------------------------------------------------------------------
# Task: Parse PDF / text file
# ---------------------------------------------------------------------------
@app.task(
    bind=True,
    name="dhub.parse_document",
    max_retries=3,
    default_retry_delay=10,
    queue=CELERY_QUEUE,
)
def parse_document(self, file_path: str, job_id: str | None = None) -> dict:
    """
    Parse a document file and return extracted text.

    Args:
        file_path: Absolute path to the file on disk
        job_id:    Optional job ID for Node.js result polling

    Returns:
        {"success": True, "text": "...", "job_id": "...", "pages": N}
    """
    task_id = self.request.id or job_id or "unknown"
    logger.info(f"[parse_document] Starting task={task_id} file={file_path}")

    if not HAS_PDF_PARSER:
        return {"success": False, "error": "pdf_parser module not available", "job_id": job_id}

    if not os.path.exists(file_path):
        return {"success": False, "error": f"File not found: {file_path}", "job_id": job_id}

    try:
        import io
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with redirect_stdout(buf):
            handle_parse(file_path)

        output = buf.getvalue()

        # handle_parse writes JSON to stdout
        try:
            result = json.loads(output)
        except json.JSONDecodeError:
            result = {"text": output, "pages": 1}

        logger.info(f"[parse_document] Completed task={task_id} chars={len(result.get('text', ''))}")
        return {"success": True, "job_id": job_id, **result}

    except Exception as exc:
        logger.error(f"[parse_document] Failed task={task_id}: {exc}", exc_info=True)
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Task: Redact PII from text
# ---------------------------------------------------------------------------
@app.task(
    bind=True,
    name="dhub.redact_pii",
    max_retries=3,
    default_retry_delay=5,
    queue=CELERY_QUEUE,
)
def redact_pii(self, text: str, language: str = "en", job_id: str | None = None) -> dict:
    """
    Detect and redact PII from raw text.

    Args:
        text:     Input text to scan
        language: BCP 47 language code (e.g. "en", "fr", "hi")
        job_id:   Optional job ID for Node.js result polling

    Returns:
        {"success": True, "redacted": "...", "findings": [...], "job_id": "..."}
    """
    task_id = self.request.id or job_id or "unknown"
    logger.info(f"[redact_pii] Starting task={task_id} lang={language} chars={len(text)}")

    if not HAS_PDF_PARSER:
        return {"success": False, "error": "pdf_parser module not available", "job_id": job_id}

    try:
        import io
        import json as _json
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with redirect_stdout(buf):
            handle_redact(text, language)

        output = buf.getvalue()

        try:
            result = _json.loads(output)
        except _json.JSONDecodeError:
            result = {"redacted": output, "findings": []}

        logger.info(f"[redact_pii] Completed task={task_id} findings={len(result.get('findings', []))}")
        return {"success": True, "job_id": job_id, **result}

    except Exception as exc:
        logger.error(f"[redact_pii] Failed task={task_id}: {exc}", exc_info=True)
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Task: Extract metadata (title, language, summary via LLM or heuristics)
# ---------------------------------------------------------------------------
@app.task(
    bind=True,
    name="dhub.extract_metadata",
    max_retries=2,
    default_retry_delay=15,
    queue=CELERY_QUEUE,
)
def extract_metadata(self, text: str, job_id: str | None = None) -> dict:
    """
    Extract document metadata from parsed text.

    Returns:
        {"success": True, "title": "...", "language": "en", "wordCount": N, "job_id": "..."}
    """
    task_id = self.request.id or job_id or "unknown"
    logger.info(f"[extract_metadata] Starting task={task_id} chars={len(text)}")

    try:
        # Language detection (heuristic)
        import re

        arabic_chars = len(re.findall(r'[\u0600-\u06FF]', text))
        hindi_chars = len(re.findall(r'[\u0900-\u097F]', text))
        chinese_chars = len(re.findall(r'[\u4E00-\u9FFF]', text))

        if arabic_chars > 50:
            language = "ar"
        elif hindi_chars > 50:
            language = "hi"
        elif chinese_chars > 50:
            language = "zh"
        else:
            language = "en"

        # Extract title from first non-empty line
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        title = lines[0][:120] if lines else "Untitled Document"

        word_count = len(text.split())
        summary = text[:500].replace('\n', ' ').strip() if text else ""

        result = {
            "success": True,
            "job_id": job_id,
            "title": title,
            "language": language,
            "wordCount": word_count,
            "summary": summary,
            "charCount": len(text),
        }

        logger.info(f"[extract_metadata] Completed task={task_id} lang={language} words={word_count}")
        return result

    except Exception as exc:
        logger.error(f"[extract_metadata] Failed task={task_id}: {exc}", exc_info=True)
        raise self.retry(exc=exc)


# ---------------------------------------------------------------------------
# Health check task (for monitoring)
# ---------------------------------------------------------------------------
@app.task(name="dhub.ping", queue=CELERY_QUEUE)
def ping() -> dict:
    return {"status": "ok", "ts": time.time(), "worker": "dhub_celery"}


# ---------------------------------------------------------------------------
# Gap 4 — PII Task Redis Listener
# Polls dhub_pii_tasks and writes results to dhub_pii_result:<jobId>.
# Runs as a background thread alongside Celery so Node.js detectPII() can
# dispatch PII jobs and poll for results without blocking the event loop.
# ---------------------------------------------------------------------------

def _pii_task_listener():
    """Background thread: consume dhub_pii_tasks from Redis, run multilang PII, write result."""
    import redis as _redis
    import subprocess
    import threading

    redis_url = REDIS_URL
    client = None

    while True:
        try:
            if client is None:
                client = _redis.from_url(redis_url, decode_responses=True)

            # Blocking pop with 5-second timeout so we exit cleanly on shutdown
            item = client.blpop("dhub_pii_tasks", timeout=5)
            if item is None:
                continue

            _, raw = item
            payload = json.loads(raw)
            job_id    = payload.get("jobId", "")
            args      = payload.get("args", {})
            text      = args.get("text", "")
            language  = args.get("language", "en")
            result_key = f"dhub_pii_result:{job_id}"

            logger.info(f"[PII-listener] job={job_id} lang={language} chars={len(text)}")

            try:
                # Prefer multilang sidecar
                script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pii_detector_multilang.py")
                if not os.path.exists(script):
                    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pdf_parser.py")
                    proc = subprocess.run(
                        [sys.executable, script, "redact", text, language],
                        capture_output=True, text=True, timeout=120,
                    )
                    result = json.loads(proc.stdout) if proc.returncode == 0 else {"error": proc.stderr}
                else:
                    proc = subprocess.run(
                        [sys.executable, script, text, language],
                        capture_output=True, text=True, timeout=120,
                    )
                    result = json.loads(proc.stdout) if proc.returncode == 0 else {"error": proc.stderr}

                client.set(result_key, json.dumps(result), ex=120)
                logger.info(f"[PII-listener] job={job_id} findings={len(result.get('findings', []))}")

            except Exception as task_err:
                client.set(result_key, json.dumps({"error": str(task_err)}), ex=60)
                logger.error(f"[PII-listener] job={job_id} error: {task_err}")

        except Exception as conn_err:
            logger.warning(f"[PII-listener] Redis connection error: {conn_err} — retrying in 5s")
            client = None
            time.sleep(5)


def start_pii_listener():
    """Start the PII task listener in a daemon thread."""
    t = __import__("threading").Thread(target=_pii_task_listener, name="pii-task-listener", daemon=True)
    t.start()
    logger.info("[PII-listener] Started on dhub_pii_tasks queue")
    return t


# Auto-start listener when this module is imported by Celery worker
import atexit as _atexit
_pii_listener_thread = None

def _on_worker_ready(**kwargs):
    global _pii_listener_thread
    _pii_listener_thread = start_pii_listener()

try:
    from celery.signals import worker_ready
    worker_ready.connect(_on_worker_ready)
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app.start()
