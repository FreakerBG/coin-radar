// Cloudflare Worker entry module. It must export only the default handler object: workerd treats every
// named export of the entry module as an entrypoint and refuses to start if one is a plain value, so all
// logic, types and constants live in scheduler/scan.ts. There is deliberately no fetch() handler.
import {handleScheduled, type SchedulerEnv} from './scan';

const scheduler = {
  async scheduled(controller: ScheduledController, env: SchedulerEnv): Promise<void> {
    await handleScheduled(controller, env);
  },
};

export default scheduler;