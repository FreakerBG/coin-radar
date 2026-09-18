// Worker entry. Every request passes through here before vinext routes it, including requests that
// vinext answers itself (a 405 for an unsupported method, a 404). Whatever the application did not
// read of the request body is consumed before the response is returned; see lib/request-body.ts.
import handler from 'vinext/server/fetch-handler';
import {withFinishedBody} from '../lib/request-body';

const worker = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return withFinishedBody(request, forwarded => handler.fetch(forwarded, env, ctx));
  },
};

export default worker;
