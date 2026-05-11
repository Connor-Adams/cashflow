import '../src/config/env';
import { AiSuggestion, sequelize } from '../src/models';

async function main() {
  const rows = await AiSuggestion.findAll({
    where: { kind: 'transaction_fields' },
    order: [['createdAt', 'DESC']],
    limit: Number(process.argv[2] || 500),
  });
  const byStatus = new Map<string, number>();
  const byPrompt = new Map<string, number>();
  let accepted = 0;
  let edited = 0;
  for (const row of rows) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    byPrompt.set(row.promptVersion ?? 'unknown', (byPrompt.get(row.promptVersion ?? 'unknown') ?? 0) + 1);
    if (row.status === 'accepted') accepted += 1;
    if (row.status === 'edited') edited += 1;
  }
  const evaluated = accepted + edited;
  console.log(
    JSON.stringify(
      {
        total: rows.length,
        evaluated,
        accepted,
        edited,
        acceptedRate: evaluated === 0 ? null : accepted / evaluated,
        byStatus: Object.fromEntries(byStatus),
        byPromptVersion: Object.fromEntries(byPrompt),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
