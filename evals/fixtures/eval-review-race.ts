export class RateLimitedClient {
  private activeRequests = 0;
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async fetch(url: string): Promise<Response> {
    // Wait until a slot is available
    while (this.activeRequests >= this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.activeRequests++;
    try {
      const response = await fetch(url);
      return response;
    } finally {
      this.activeRequests--;
    }
  }
}
