export interface AuthenticatedUser {
  id: string;
  recoveryEmail: string | null;
  username: string;
}

export interface LoginCredentials {
  password: string;
  username: string;
}

export interface RegisterCredentials extends LoginCredentials {
  recoveryEmail: string;
}
