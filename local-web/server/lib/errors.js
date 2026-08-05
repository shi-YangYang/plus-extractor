"use strict";

class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function pendingAdapter(code, message) {
  return new AppError(501, code, message);
}

module.exports = { AppError, pendingAdapter };
