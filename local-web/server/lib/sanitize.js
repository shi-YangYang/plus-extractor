"use strict";

function sanitizeText(value, limit = 500) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[\w.%+-]+:[^@\s]+@[\w.-]+:\d{1,5}\b/g, "[PROXY_REDACTED]")
    .replace(/(\/messages\/)[^/\s?#]+\/[^?\s#]+/gi, "$1[REDACTED]/[EMAIL_REDACTED]")
    .replace(/(https:\/\/icloud-api\.top\/s\/)[^/\s?#]+\/[^?\s#]+/gi, "$1[REDACTED]/[EMAIL_REDACTED]")
    .replace(/([?&]mail=)[^&\s]+/gi, "$1[EMAIL_REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_REDACTED]")
    .replace(/([?&](?:code|state|token|key|secret|session|authorization|pwd|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\boaics_[A-Za-z0-9_-]{16,160}\b/g, "oaics_[REDACTED]")
    .replace(/\bcs_(live|test)_[A-Za-z0-9_-]{6,512}\b/g, "cs_$1_[REDACTED]")
    .replace(/\bseti_[A-Za-z0-9]{8,}_secret_[A-Za-z0-9]{8,}\b/g, "seti_[REDACTED]")
    .replace(/\bpm_[A-Za-z0-9]{8,255}\b/g, "pm_[REDACTED]")
    .replace(/\bpk_(live|test)_[A-Za-z0-9]{20,}\b/g, "pk_$1_[REDACTED]")
    .replace(/\b(?:\d[ -]*?){12,19}\b/g, "[CARD_REDACTED]")
    .slice(0, Math.max(1, limit));
}

function publicError(error) {
  return {
    ok: false,
    error: error && error.code ? error.code : "INTERNAL_ERROR",
    message: sanitizeText(error && error.message ? error.message : "Internal server error", 300)
  };
}

module.exports = { sanitizeText, publicError };
