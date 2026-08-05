"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../lib/errors");

const DEFAULT_DATA_PATH = path.resolve(__dirname, "../data/us-profile-address-pools.json");
const DEFAULT_REFERENCE_PATH = DEFAULT_DATA_PATH;
const OUTPUT_KEYS = Object.freeze(["lastName", "firstName", "postalCode", "fullAddress"]);
const ALLOWED_STATE_CODES = Object.freeze(["DE"]);
const NAME_PATTERN = /^[A-Z][A-Za-z'-]{1,49}$/;
const TEXT_PATTERN = /^[A-Za-z][A-Za-z .'-]{0,79}$/;

function normalizeUniqueStrings(values, field, pattern) {
  if (!Array.isArray(values) || !values.length) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", `${field} must be a non-empty array.`);
  }
  const normalized = values.map((value, index) => {
    const text = String(value || "").trim();
    if (!pattern.test(text)) {
      throw new AppError(500, "ADDRESS_POOL_INVALID", `${field}[${index}] is invalid.`);
    }
    return text;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", `${field} contains duplicate values.`);
  }
  return Object.freeze(normalized);
}

function normalizeLocality(row, index) {
  const locality = {
    postalCode: String(row && row.postalCode || "").trim(),
    city: String(row && row.city || "").trim(),
    stateCode: String(row && row.stateCode || "").trim(),
    stateName: String(row && row.stateName || "").trim()
  };
  if (!/^\d{5}$/.test(locality.postalCode)) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", `localities[${index}] has an invalid postalCode.`);
  }
  if (!TEXT_PATTERN.test(locality.city) || !TEXT_PATTERN.test(locality.stateName)) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", `localities[${index}] has an invalid place name.`);
  }
  if (!ALLOWED_STATE_CODES.includes(locality.stateCode)) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", `localities[${index}] has an unsupported stateCode.`);
  }
  return Object.freeze(locality);
}

function normalizePoolData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", "The address pool root must be an object.");
  }
  if (!Array.isArray(data.localities) || !data.localities.length) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", "localities must be a non-empty array.");
  }
  const localities = data.localities.map(normalizeLocality);
  const localityKeys = localities.map((row) => `${row.postalCode}\u0000${row.city.toLowerCase()}\u0000${row.stateCode}`);
  if (new Set(localityKeys).size !== localityKeys.length) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", "localities contains duplicate city/state/postal-code tuples.");
  }
  const stateCodes = [...new Set(localities.map((row) => row.stateCode))].sort();
  if (JSON.stringify(stateCodes) !== JSON.stringify([...ALLOWED_STATE_CODES].sort())) {
    throw new AppError(500, "ADDRESS_POOL_INVALID", "localities must cover all configured state codes.");
  }
  return Object.freeze({
    metadata: Object.freeze(data.metadata && typeof data.metadata === "object" ? { ...data.metadata } : {}),
    firstNames: normalizeUniqueStrings(data.firstNames, "firstNames", NAME_PATTERN),
    lastNames: normalizeUniqueStrings(data.lastNames, "lastNames", NAME_PATTERN),
    localities: Object.freeze(localities),
    streetBases: normalizeUniqueStrings(data.streetBases, "streetBases", TEXT_PATTERN),
    streetSuffixes: normalizeUniqueStrings(data.streetSuffixes, "streetSuffixes", /^[A-Za-z]{1,10}$/)
  });
}

class ProfileAddressGenerator {
  constructor(options = {}) {
    this.dataPath = path.resolve(options.dataPath || options.referencePath || DEFAULT_DATA_PATH);
    this.referencePath = this.dataPath;
    this.randomInt = options.randomInt || crypto.randomInt;
    this.pools = this.load();
  }

  load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.dataPath, "utf8"));
    } catch (error) {
      throw new AppError(500, "ADDRESS_POOL_INVALID", "The profile-address pool JSON could not be loaded.", error);
    }
    return normalizePoolData(data);
  }

  randomIndex(length, field) {
    const index = this.randomInt(length);
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new AppError(500, "ADDRESS_RANDOM_INDEX_INVALID", `The address generator returned an invalid ${field} index.`);
    }
    return index;
  }

  pick(values, field) {
    return values[this.randomIndex(values.length, field)];
  }

  generate() {
    const lastName = this.pick(this.pools.lastNames, "lastName");
    const firstName = this.pick(this.pools.firstNames, "firstName");
    const locality = this.pick(this.pools.localities, "locality");
    const streetBase = this.pick(this.pools.streetBases, "streetBase");
    const streetSuffix = this.pick(this.pools.streetSuffixes, "streetSuffix");
    const houseNumber = 100 + this.randomIndex(9900, "houseNumber");
    return Object.freeze({
      lastName,
      firstName,
      postalCode: locality.postalCode,
      fullAddress: `${houseNumber} ${streetBase} ${streetSuffix}, ${locality.city}, ${locality.stateCode} ${locality.postalCode}, USA`
    });
  }

  describe() {
    const counts = {
      firstNames: this.pools.firstNames.length,
      lastNames: this.pools.lastNames.length,
      localities: this.pools.localities.length,
      streetBases: this.pools.streetBases.length,
      streetSuffixes: this.pools.streetSuffixes.length,
      houseNumbers: 9900
    };
    const potentialAddresses = BigInt(counts.localities)
      * BigInt(counts.streetBases)
      * BigInt(counts.streetSuffixes)
      * BigInt(counts.houseNumbers);
    return Object.freeze({
      outputKeys: OUTPUT_KEYS,
      stateCodes: ALLOWED_STATE_CODES,
      counts: Object.freeze(counts),
      recordCount: counts.localities,
      potentialAddresses: potentialAddresses.toString(),
      potentialProfiles: (potentialAddresses * BigInt(counts.firstNames) * BigInt(counts.lastNames)).toString()
    });
  }
}

module.exports = {
  ALLOWED_STATE_CODES,
  DEFAULT_DATA_PATH,
  DEFAULT_REFERENCE_PATH,
  OUTPUT_KEYS,
  ProfileAddressGenerator,
  normalizeLocality,
  normalizePoolData
};
