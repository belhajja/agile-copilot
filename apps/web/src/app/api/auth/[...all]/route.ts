import { toNextJsHandler } from 'better-auth/next-js';
import { services } from '@/server/context';

const handler = () => toNextJsHandler(services().auth);

export const GET = (req: Request) => handler().GET(req);
export const POST = (req: Request) => handler().POST(req);
