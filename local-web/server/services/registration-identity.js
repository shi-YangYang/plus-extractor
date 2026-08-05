"use strict";

const crypto = require("node:crypto");
const { AppError } = require("../lib/errors");

const FIRST_NAMES = Object.freeze([
  "Adrian", "Caleb", "Daniel", "Elliot", "Ethan", "Felix", "Gavin", "Henry",
  "Julian", "Lucas", "Marcus", "Nathan", "Oliver", "Ryan", "Simon", "Victor"
]);
const LAST_NAMES = Object.freeze([
  "Bennett", "Carter", "Collins", "Dawson", "Foster", "Griffin", "Hayes",
  "Miller", "Parker", "Reed", "Sullivan", "Turner", "Walker", "Wright"
]);

function parseDateOnly(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function ageOnDate(birthdate, now = new Date()) {
  const birth = birthdate instanceof Date ? birthdate : parseDateOnly(birthdate);
  if (!birth || Number.isNaN(now.getTime())) return Number.NaN;
  const birthdayPending = now.getUTCMonth() < birth.getUTCMonth()
    || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  return now.getUTCFullYear() - birth.getUTCFullYear() - (birthdayPending ? 1 : 0);
}

function generateRegistrationIdentity(options = {}) {
  const now = options.now instanceof Date ? new Date(options.now) : new Date();
  const randomInt = options.randomInt || crypto.randomInt;
  const firstName = FIRST_NAMES[randomInt(FIRST_NAMES.length)];
  const lastName = LAST_NAMES[randomInt(LAST_NAMES.length)];
  const age = randomInt(20, 41);
  const month = randomInt(1, 13);
  const daySeed = randomInt(1, 29);
  const birthdayPending = month > now.getUTCMonth() + 1
    || (month === now.getUTCMonth() + 1 && daySeed > now.getUTCDate());
  const year = now.getUTCFullYear() - age - (birthdayPending ? 1 : 0);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(daySeed, maxDay);
  return Object.freeze({
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    age,
    birthdate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    generatedAt: now.toISOString()
  });
}

function normalizeRegistrationIdentity(input = {}, options = {}) {
  const fullName = String(input.fullName || "").trim();
  const age = Number(input.age);
  const birthdate = String(input.birthdate || "");
  const generatedAt = String(input.generatedAt || "");
  const storedDate = generatedAt ? new Date(generatedAt) : null;
  const now = options.now instanceof Date
    ? options.now
    : storedDate && !Number.isNaN(storedDate.getTime()) ? storedDate : new Date();
  if (!/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(fullName)) {
    throw new AppError(400, "INVALID_GENERATED_NAME", "Generated profile name must use First Last format.");
  }
  if (!Number.isInteger(age) || age < 20 || age > 40) {
    throw new AppError(400, "INVALID_GENERATED_AGE", "Generated profile age must be from 20 to 40.");
  }
  if (!parseDateOnly(birthdate) || ageOnDate(birthdate, now) !== age) {
    throw new AppError(400, "INVALID_GENERATED_BIRTHDATE", "Generated birthdate must match the generated age.");
  }
  const [firstName, lastName] = fullName.split(" ", 2);
  return Object.freeze({
    firstName,
    lastName,
    fullName,
    age,
    birthdate,
    generatedAt: generatedAt || now.toISOString()
  });
}

module.exports = {
  FIRST_NAMES,
  LAST_NAMES,
  ageOnDate,
  generateRegistrationIdentity,
  normalizeRegistrationIdentity,
  parseDateOnly
};
