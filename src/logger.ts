/** Minimal structured logger */
function ts(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export const logger = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(`${ts()} info: ${msg}`, data ? JSON.stringify(data) : '');
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(`${ts()} error: ${msg}`, data ? JSON.stringify(data) : '');
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(`${ts()} warn: ${msg}`, data ? JSON.stringify(data) : '');
  },
  debug(msg: string, _data?: Record<string, unknown>) {
    // Uncomment for verbose debugging:
    // console.debug(`${ts()} debug: ${msg}`, _data ? JSON.stringify(_data) : '');
  },
};
