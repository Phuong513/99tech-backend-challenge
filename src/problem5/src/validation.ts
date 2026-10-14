export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export interface TaskInput {
  title: string;
  description: string;
  status: TaskStatus;
}

export function parseStatus(value: unknown): TaskStatus {
  if (value !== 'pending' && value !== 'in_progress' && value !== 'completed') {
    throw new HttpError(400, 'status must be pending, in_progress, or completed');
  }
  return value;
}

export function parseBody(value: unknown, partial: boolean): Partial<TaskInput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => !['title', 'description', 'status'].includes(key))) {
    throw new HttpError(400, 'Only title, description, and status may be supplied');
  }
  if (partial && keys.length === 0) {
    throw new HttpError(400, 'Provide at least one field to update');
  }
  const result: Partial<TaskInput> = {};
  if (!partial || Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200) {
      throw new HttpError(400, 'title must contain 1 to 200 characters after trimming');
    }
    result.title = body.title.trim();
  }
  if (Object.hasOwn(body, 'description')) {
    if (typeof body.description !== 'string' || body.description.length > 5000) {
      throw new HttpError(400, 'description must be a string of at most 5000 characters');
    }
    result.description = body.description;
  }
  if (Object.hasOwn(body, 'status')) {
    result.status = parseStatus(body.status);
  }
  return result;
}

export function parseInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}
