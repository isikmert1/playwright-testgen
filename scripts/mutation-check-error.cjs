class MutationCheckError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new MutationCheckError(code);
}

module.exports = { MutationCheckError, fail };
