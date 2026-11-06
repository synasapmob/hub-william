export interface ServiceKey {
  createdAt: string;
  id: string;
  lastFour: string;
  lastUsedAt: string | null;
}

export interface CreatedServiceKey extends ServiceKey {
  // The whole key. It is returned once, when the key is created.
  key: string;
}
