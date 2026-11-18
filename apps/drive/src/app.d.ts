import type { DriveAuthEnv, readSession } from './lib/server/request-auth';

declare global {
  namespace App {
    interface Platform {
      env: DriveAuthEnv;
    }
    interface Locals {
      driveSession?: NonNullable<Awaited<ReturnType<typeof readSession>>>;
    }
  }
}

export {};
