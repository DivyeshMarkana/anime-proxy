'use strict';

const SENSITIVE_KEY_PATTERN =
  /authorization|token|api[_-]?key|secret|password|credential|cookie/i;

/**
 * Recursively redact sensitive fields before logging.
 * @param {unknown} value
 * @returns {unknown}
 */
function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = redact(nested);
      }
    }
    return output;
  }
  return value;
}

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Create a structured logger that never prints credentials.
 * @param {string} [level]
 */
function createLogger(level = process.env.LOG_LEVEL || 'info') {
  const currentLevel = LEVELS[level] ?? LEVELS.info;

  /**
   * @param {'error'|'warn'|'info'|'debug'} severity
   * @param {string} message
   * @param {Record<string, unknown>} [meta]
   */
  function write(severity, message, meta = {}) {
    if ((LEVELS[severity] ?? 99) > currentLevel) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level: severity,
      message,
      ...redact(meta),
    };

    const line = JSON.stringify(entry);
    // Suppress noisy logs during automated tests
    if (process.env.NODE_ENV === 'test' && severity !== 'error') {
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      // Keep errors available for debugging failures without Jest console noise spam
      // by writing to stderr only when LOG_LEVEL=debug
      if ((process.env.LOG_LEVEL || 'error') === 'error') {
        return;
      }
    }
    if (severity === 'error') {
      console.error(line);
    } else if (severity === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}

const logger = createLogger();

module.exports = {
  logger,
  createLogger,
  redact,
};
