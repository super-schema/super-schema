export type ServiceError = {
  code: string;
  message: string;
  details?: object;
  suggestedFix?: string;
};

export type Result<T, E = ServiceError> =
  | { success: true; data: T }
  | { success: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err(error: ServiceError): Result<never> {
  return { success: false, error };
}
