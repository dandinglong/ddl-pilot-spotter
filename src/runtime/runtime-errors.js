"use strict";

class OwnershipConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OwnershipConflictError";
    this.details = { ...details };
  }
}

class ProfileUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProfileUnavailableError";
    this.details = { ...details };
  }
}

class StaleOwnershipRecoveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StaleOwnershipRecoveryError";
    this.details = { ...details };
  }
}

class RuntimeRecoveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RuntimeRecoveryError";
    this.details = { ...details };
  }
}

module.exports = {
  OwnershipConflictError,
  ProfileUnavailableError,
  RuntimeRecoveryError,
  StaleOwnershipRecoveryError,
};
