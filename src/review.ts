import { completionEmail, statusUrlFor } from './intake/email.js';
import { completedRequestForTask, getRequestResults } from './intake/operations.js';
import { type SendEmailBinding, sendEmail } from './mailer.js';
import { acceptTask } from './operations.js';
import { resultsToFile } from './results.js';

/**
 * Accept a submitted task and, if that completes its whole intake request, email
 * the nonprofit the results. Shared by the dev /submit auto-accept (verified
 * volunteers flow straight to the nonprofit) and the admin accept route. The
 * accept is the source of truth; a completion-email failure is non-fatal.
 */
export async function acceptTaskAndNotify(
  taskId: string,
  binding: SendEmailBinding | undefined,
): Promise<{ task_id: string; status: 'accepted' }> {
  const res = await acceptTask(taskId);
  try {
    const done = await completedRequestForTask(taskId);
    if (done) {
      const results = await getRequestResults(done.request_id);
      await sendEmail(
        binding,
        completionEmail({
          to: done.from_email,
          statusUrl: statusUrlFor(done.request_id),
          // Attach the results so they're in the inbox; omit if there's nothing.
          attachment: results.length ? resultsToFile(results) : undefined,
        }),
      );
    }
  } catch (err) {
    console.error('completion notify failed', err);
  }
  return res;
}
