import { defineJob } from '../registry';
import { trimClientErrors } from '../../audit/clientErrorBuffer';
import { trimServerErrors } from '../../audit/serverErrorBuffer';

defineJob({
  name: 'audit_buffer_trim',
  cronDefault: '0 3 * * *',
  enabledDefault: true,
  handler: async () => {
    const clientTrimmed = trimClientErrors();
    const serverTrimmed = trimServerErrors();
    return { summary: { clientTrimmed, serverTrimmed } };
  },
});
