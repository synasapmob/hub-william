export interface GatewayKey {
  createdAt: string;
  id: string;
  lastFour: string;
  lastUsedAt: string | null;
}

export interface CreatedGatewayKey extends GatewayKey {
  key: string;
}
