"""
pii_detector_multilang.py — Multi-language PII detection sidecar (Gap 16)

Supports: English, French, German, Spanish, Hindi, Arabic, Chinese, Japanese,
          Portuguese, Italian, Russian, Dutch, Korean

Uses:
  - presidio-analyzer with spaCy language models for regex + NER based detection
  - Fallback: pure-Python regex patterns for languages without spaCy models

Install:
  pip install presidio-analyzer presidio-anonymizer
  pip install spacy
  python -m spacy download en_core_web_sm   # English (required)
  python -m spacy download fr_core_news_sm  # French (optional)
  python -m spacy download de_core_news_sm  # German (optional)
  python -m spacy download es_core_news_sm  # Spanish (optional)

Usage:
  python pii_detector_multilang.py <text> [language_code]
  python pii_detector_multilang.py "Jean Dupont travaille chez ACME" fr
  # Returns JSON: {"findings": [...], "redacted": "...", "language": "fr"}
"""

import sys
import json
import re

# ---------------------------------------------------------------------------
# Language detection (lightweight)
# ---------------------------------------------------------------------------
def detect_language(text: str) -> str:
    """Simple script-based language hint. Returns BCP-47 code."""
    # Arabic
    if re.search(r"[\u0600-\u06FF]", text):
        return "ar"
    # Chinese
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    # Japanese (Hiragana / Katakana)
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    # Hindi (Devanagari)
    if re.search(r"[\u0900-\u097F]", text):
        return "hi"
    # Korean (Hangul)
    if re.search(r"[\uAC00-\uD7A3]", text):
        return "ko"
    # Russian (Cyrillic)
    if re.search(r"[\u0400-\u04FF]", text):
        return "ru"
    return "en"  # default


# ---------------------------------------------------------------------------
# Regex-based PII patterns (language-agnostic anchors)
# ---------------------------------------------------------------------------
REGEX_PATTERNS = [
    ("EMAIL",        r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
    ("PHONE",        r"\+?\d[\d\s\-().]{8,}\d"),
    ("SSN",          r"\b\d{3}-\d{2}-\d{4}\b"),
    ("CREDIT_CARD",  r"\b(?:\d[ -]?){13,16}\b"),
    ("IBAN",         r"\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,30}\b"),
    ("IP_ADDRESS",   r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    ("API_KEY",      r"\b(?:sk-|pk-|AKIA|ghp_)[A-Za-z0-9_\-]{20,}\b"),
    ("PRIVATE_KEY",  r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----"),
    ("URL",          r"https?://[^\s\"'<>]+"),
    ("DATE",         r"\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b"),
    ("PASSPORT",     r"\b[A-Z]{1,2}\d{6,9}\b"),          # Generic passport-like
    ("DRIVING_LIC",  r"\b[A-Z]{2}\d{6,8}\b"),             # Generic driving licence
    ("NI_NUMBER",    r"\b[A-Z]{2}\d{6}[A-D]\b"),          # UK National Insurance
    ("PAN",          r"\b[A-Z]{5}\d{4}[A-Z]\b"),          # India PAN card
    ("AADHAAR",      r"\b\d{4}\s\d{4}\s\d{4}\b"),         # India Aadhaar
]


def regex_pii_detect(text: str) -> list:
    findings = []
    for pii_type, pattern in REGEX_PATTERNS:
        for match in re.finditer(pattern, text):
            findings.append({
                "type": pii_type,
                "value": match.group(),
                "start": match.start(),
                "end": match.end(),
                "source": "regex",
            })
    return findings


def regex_pii_redact(text: str, findings: list) -> str:
    # Sort by start position descending (replace from end to avoid offset drift)
    for f in sorted(findings, key=lambda x: x["start"], reverse=True):
        replacement = f"[{f['type']}]"
        text = text[:f["start"]] + replacement + text[f["end"]:]
    return text


# ---------------------------------------------------------------------------
# Presidio-based NER detection (English + spaCy language models)
# ---------------------------------------------------------------------------
SPACY_LANG_MODELS = {
    "en": "en_core_web_sm",
    "fr": "fr_core_news_sm",
    "de": "de_core_news_sm",
    "es": "es_core_news_sm",
    "pt": "pt_core_news_sm",
    "it": "it_core_news_sm",
    "nl": "nl_core_news_sm",
    "zh": "zh_core_web_sm",
}

def presidio_detect(text: str, language: str) -> tuple:
    """Returns (findings, redacted_text) using Microsoft Presidio."""
    from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
    from presidio_anonymizer import AnonymizerEngine

    registry = RecognizerRegistry()
    registry.load_predefined_recognizers(languages=[language])

    analyzer = AnalyzerEngine(registry=registry)
    anonymizer = AnonymizerEngine()

    results = analyzer.analyze(text=text, language=language)
    anonymized = anonymizer.anonymize(text=text, analyzer_results=results)

    findings = [
        {
            "type": r.entity_type,
            "start": r.start,
            "end": r.end,
            "score": round(r.score, 3),
            "value": text[r.start:r.end],
            "source": "presidio",
        }
        for r in results
    ]
    return findings, anonymized.text


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run(text: str, language: str = "en") -> dict:
    if not language or language == "auto":
        language = detect_language(text)

    # Try Presidio first (best quality)
    try:
        presidio_findings, presidio_redacted = presidio_detect(text, language)
        # Supplement with regex for types Presidio misses
        regex_findings = regex_pii_detect(text)
        # Merge: prefer Presidio results, add regex-only findings
        presidio_spans = {(f["start"], f["end"]) for f in presidio_findings}
        extra = [f for f in regex_findings if (f["start"], f["end"]) not in presidio_spans]
        all_findings = presidio_findings + extra

        # Final redacted text: start from presidio output and apply regex extras
        redacted = regex_pii_redact(presidio_redacted, extra) if extra else presidio_redacted

        return {
            "findings": all_findings,
            "redacted": redacted,
            "language": language,
            "engine": "presidio+regex",
        }
    except (ImportError, Exception) as e:
        # Presidio unavailable — pure regex fallback
        findings = regex_pii_detect(text)
        redacted = regex_pii_redact(text, findings)
        return {
            "findings": findings,
            "redacted": redacted,
            "language": language,
            "engine": "regex",
            "fallback_reason": str(e),
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: pii_detector_multilang.py <text> [language]"}))
        sys.exit(1)

    input_text = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "auto"
    print(json.dumps(run(input_text, lang)))
