export class ChatLogger {
  static info(event: string, metadata: any) {
    console.log(JSON.stringify({
      level: 'INFO',
      timestamp: new Date().toISOString(),
      event,
      ...metadata
    }));
  }

  static error(event: string, error: any, metadata: any = {}) {
    console.error(JSON.stringify({
      level: 'ERROR',
      timestamp: new Date().toISOString(),
      event,
      error: error instanceof Error ? error.message : String(error),
      ...metadata
    }));
  }

  static warn(event: string, metadata: any) {
    console.warn(JSON.stringify({
      level: 'WARN',
      timestamp: new Date().toISOString(),
      event,
      ...metadata
    }));
  }
}
