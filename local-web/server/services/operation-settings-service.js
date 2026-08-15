"use strict";

const { AppError } = require("../lib/errors");

const DEFAULT_MAX_ACCOUNT_OPERATIONS = 10;
const MAX_ACCOUNT_OPERATIONS = 30;
const MAX_ROXY_WINDOWS = 15;
const REGISTRATION_MODES = Object.freeze(["protocol", "roxybrowser"]);

function normalizeSettings(input = {}, current = {}) {
  const rawMaximum = Object.hasOwn(input, "maxAccountOperations")
    ? input.maxAccountOperations
    : current.maxAccountOperations ?? DEFAULT_MAX_ACCOUNT_OPERATIONS;
  const maxAccountOperations = Number(rawMaximum);
  if (!Number.isInteger(maxAccountOperations)
      || maxAccountOperations < 1
      || maxAccountOperations > MAX_ACCOUNT_OPERATIONS) {
    throw new AppError(
      400,
      "MAX_ACCOUNT_OPERATIONS_INVALID",
      `Maximum account operations must be an integer from 1 through ${MAX_ACCOUNT_OPERATIONS}.`
    );
  }

  const registrationMode = String(
    Object.hasOwn(input, "registrationMode")
      ? input.registrationMode
      : current.registrationMode || "protocol"
  ).trim().toLowerCase();
  if (!REGISTRATION_MODES.includes(registrationMode)) {
    throw new AppError(
      400,
      "REGISTRATION_MODE_INVALID",
      `Registration mode must be one of: ${REGISTRATION_MODES.join(", ")}.`
    );
  }

  return Object.freeze({ maxAccountOperations, registrationMode });
}

class OperationSettingsService {
  constructor(store) {
    this.store = store;
    this.settings = normalizeSettings();
  }

  async init() {
    this.settings = normalizeSettings(await this.store.read());
    return this.summary();
  }

  summary() {
    const maxAccountOperations = this.settings.maxAccountOperations;
    return Object.freeze({
      maxAccountOperations,
      registrationMode: this.settings.registrationMode,
      roxyWindowCount: Math.ceil(maxAccountOperations / 2),
      accountsPerRoxyWindow: 2,
      maxRoxyWindows: MAX_ROXY_WINDOWS,
      maxSupportedAccounts: MAX_ACCOUNT_OPERATIONS
    });
  }

  async replace(input = {}) {
    const next = normalizeSettings(input, this.settings);
    await this.store.write(next);
    this.settings = next;
    return this.summary();
  }
}

module.exports = {
  DEFAULT_MAX_ACCOUNT_OPERATIONS,
  MAX_ACCOUNT_OPERATIONS,
  MAX_ROXY_WINDOWS,
  OperationSettingsService,
  REGISTRATION_MODES,
  normalizeSettings
};
