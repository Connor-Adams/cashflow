import path from 'path';
import { Account } from '../models';
import { parseStatementFile } from '../import/parseStatementFile';
import { commitStatementImport } from '../import/commitStatementImport';
import * as env from '../config/env';
import { inferAccountMeta } from './inferAccountMeta';
import {
  isOnboardingAccountType,
  toAccountColumnType,
  type OnboardingAccountType,
} from './accountType';

/** Error codes surfaced to the wizard (issue #259 API contract). */
export type OnboardingImportErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'NO_TRANSACTIONS'
  | 'PARSE_ERROR'
  | 'MISSING_ACCOUNT_NAME';

export type OnboardingImportOk = {
  ok: true;
  accountId: number;
  accountName: string;
  importedCount: number;
  accountCreated: boolean;
};

export type OnboardingImportErr = {
  ok: false;
  code: OnboardingImportErrorCode;
  error: string;
};

export type OnboardingImportResult = OnboardingImportOk | OnboardingImportErr;

/** Extensions the import pipeline can parse (mirrors parseStatementFile). */
const SUPPORTED_EXTS = new Set(['.csv', '.ofx', '.qfx', '.pdf']);

/**
 * `parseStatementFile` returns a free-text `error` string on failure. Map the
 * known "format not understood" messages to UNSUPPORTED_FORMAT; everything
 * else is a genuine PARSE_ERROR. We've already gated the extension up front,
 * so reaching here with an unsupported-format message means the bytes didn't
 * match any registered parser (e.g. a `.pdf` whose layout has no parser).
 */
function classifyParseError(message: string): OnboardingImportErrorCode {
  const m = message.toLowerCase();
  if (
    m.includes('only .csv') ||
    m.includes('no pdf parser') ||
    m.includes('supported')
  ) {
    return 'UNSUPPORTED_FORMAT';
  }
  return 'PARSE_ERROR';
}

/**
 * First-run onboarding import: create an account from the dropped file
 * (inferring name/type, or using the caller-supplied values), parse the
 * statement, and commit the transactions in one shot.
 *
 * Reuses the same `parseStatementFile -> commitStatementImport` pipeline the
 * Wealthsimple/PDF bundle importers use, so dedup, fingerprinting, and
 * enrichment behave identically to a normal upload (#259).
 */
export async function runOnboardingImport(opts: {
  buffer: Buffer;
  fileName: string;
  householdId: number;
  userId: number;
  accountName?: string | null;
  accountType?: string | null;
}): Promise<OnboardingImportResult> {
  const fileName = path.basename(opts.fileName || '').replace(/[\\/]/g, '');
  const ext = path.extname(fileName).toLowerCase();

  if (!SUPPORTED_EXTS.has(ext)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      error: "We don't recognize this format. Supported: CSV, OFX, QIF.",
    };
  }

  // Resolve account name + type: explicit caller value wins, else infer.
  const inferred = inferAccountMeta({ fileName, buffer: opts.buffer });

  const explicitName =
    typeof opts.accountName === 'string' && opts.accountName.trim() !== ''
      ? opts.accountName.trim()
      : null;
  const accountName = explicitName ?? inferred?.name ?? null;

  if (!accountName) {
    return {
      ok: false,
      code: 'MISSING_ACCOUNT_NAME',
      error:
        'We could not detect an account name from this file. Enter a name and type to continue.',
    };
  }

  // Type precedence: explicit (validated) > inferred > 'checking'.
  let onboardingType: OnboardingAccountType;
  if (opts.accountType != null && opts.accountType !== '') {
    if (!isOnboardingAccountType(opts.accountType)) {
      return {
        ok: false,
        code: 'PARSE_ERROR',
        error:
          "accountType must be one of: checking, savings, credit, investment, other.",
      };
    }
    onboardingType = opts.accountType;
  } else {
    onboardingType = inferred?.type ?? 'checking';
  }
  const accountColumnType = toAccountColumnType(onboardingType);

  const account = await Account.create({
    name: accountName,
    owner: 'me',
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    visibility: 'private',
    accountType: accountColumnType,
    defaultCurrency: env.defaultCurrency,
  });

  const preview = await parseStatementFile({
    buffer: opts.buffer,
    fileName,
    accountId: account.id,
    householdId: opts.householdId,
  });

  if ('error' in preview) {
    // Roll back the just-created account so a parse failure doesn't strand an
    // empty account the user never asked for.
    await account.destroy();
    return {
      ok: false,
      code: classifyParseError(preview.error),
      error: preview.error,
    };
  }

  const commit = await commitStatementImport(
    preview,
    opts.userId,
    opts.householdId,
  );
  const importedCount =
    commit.insertedTransactions +
    commit.insertedInvestmentActivities +
    commit.insertedHoldings;

  if (importedCount === 0) {
    // Parsed cleanly but produced nothing to import. Drop the empty account
    // and report NO_TRANSACTIONS distinctly from a parse failure (AC #8).
    await account.destroy();
    return {
      ok: false,
      code: 'NO_TRANSACTIONS',
      error:
        'Your file parsed but no transactions were found. Check the format or set up your account manually.',
    };
  }

  return {
    ok: true,
    accountId: account.id,
    accountName: account.name,
    importedCount,
    accountCreated: true,
  };
}
