import type { readSession } from './lib/server/request-auth';

declare global {
  namespace App {
    interface Locals {
      driveSession?: NonNullable<Awaited<ReturnType<typeof readSession>>>;
    }
  }
}

export {};
