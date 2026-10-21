export interface CatalogCollectionFile {
  path: string;
  url: string;
  name: string;
  title: string;
  description: string;
  source: string;
}

export interface CatalogCollection {
  id: string;
  /** The contributor folder it lives in: tools, skills, scripts, ... */
  catalogue: string;
  contributor: string | null;
  label: string;
  summary: string;
  files: CatalogCollectionFile[];
}

export interface CatalogArchive {
  name: string;
  url: string;
}
