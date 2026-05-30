export interface ChangelogEntryDto {
  version: string;
  title: string;
  publishedAt: string;
  html: string;
}

export interface ChangelogLatest {
  empty?: true;
  version?: string;
  title?: string;
  publishedAt?: string;
  html?: string;
  unread?: boolean;
}

export interface ChangelogOverviewDto {
  empty?: true;
  html?: string;
  updatedAt?: string;
}

export interface ChangelogListDto {
  entries: ChangelogEntryDto[];
}
