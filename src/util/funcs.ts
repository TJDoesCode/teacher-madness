import { Poll, Vote } from '@typings';
import { VercelRequest, VercelResponse } from '@vercel/node';
import { db, users } from './db';
import { v4 as uuidv4 } from 'uuid';
import { serialize } from 'cookie';

interface _IDObj {
	id: number;
}

class InvalidJSONError extends Error {
	constructor(args?: string) {
		super(args ?? 'Malformed JSON');
	}
}

export class DBInitError extends Error {
	constructor(args?: string) {
		super(args ?? 'Database initialization failed');
	}
}

export type NowReturn = Promise<void | VercelResponse>;
export type NowFunc = (req: VercelRequest, res: VercelResponse) => NowReturn;

type tryHandleOptions = { shouldAllowCors?: boolean };

/**
 * Wrapper to execute a serverless function and safely handle errors.
 * @param handle Serverless function to execute (should take a VercelRequest and VercelResponse)
 * @param method HTTP method to enforce
 * @param {Object} options Additional options
 * @param {Boolean} options.shouldAllowCors Allow Cross-Origin requests
 */
export const tryHandleFunc = (
	handle: NowFunc,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PURGE',
	options: tryHandleOptions = { shouldAllowCors: false }
) => async (req: VercelRequest, res: VercelResponse): NowReturn => {
	if (req.method?.toUpperCase() !== method) {
		return res.status(405).send(`Invalid HTTP method (expected ${method})`);
	}

	try {
		if (!process.env.NODE_ENV) return;
		await handle(req, res);
	} catch (err) {
		const stackOrObj = err.stack ?? err;
		if (err instanceof InvalidJSONError) return res.status(422).send(stackOrObj);
		return res.status(500).send(`Uncaught internal server error: \n${stackOrObj}`);
	}

	if (options?.shouldAllowCors) {
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', method + ',OPTIONS');
		res.setHeader(
			'Access-Control-Allow-Headers',
			'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
		);
		if (req.method === 'OPTIONS') {
			return res.status(200).end();
		}
	}
};

export async function getUserId(req: VercelRequest, res: VercelResponse) {
	if (!users) throw new DBInitError();

	let userId = getCookie(req, 'user-id');
	let putDb = '';

	if (!userId) {
		userId = uuidv4();

		putDb = (((await users.put(userId)) as unknown) as { value: string }).value;
		const idCookie = serialize('user-id', userId, { httpOnly: true });
		res.setHeader('Set-Cookie', [idCookie]);
	}

	const dbId = putDb
		? userId
		: ((await (await users.fetch({ value: userId }))[Symbol.asyncIterator]().next())
				.value as Array<{ value: string }>)[0].value;
	//console.log((await (await users.fetch({ value: userId }))[Symbol.asyncIterator]().next()).value);
	console.log(`userId: ${userId}, putDb: ${putDb}, dbId: ${dbId}`);

	if (dbId !== userId) res.status(401).send('User ID is not recognized');
	return userId;
}

export function getCookie(req: VercelRequest, name: string) {
	const rawCookies = req.headers.cookie?.split('; ');
	const present = rawCookies?.find(c => c.split('=')[0] === name);
	const value = present?.split('=')[1] as string;

	return present != null ? value : null;
}

export function getForwardedHeader(req: VercelRequest) {
	// rawHeaders are stored in one array with both keys and values
	// See https://nodejs.org/api/http.html#http_class_http_incomingmessage
	const forwardedIdx = req.rawHeaders.findIndex(h => h.toLowerCase() === 'x-forwarded-for');
	return req.rawHeaders[forwardedIdx + 1];
}

/**
 * Attempt to parse the request body of a Vercel serverless function
 * @param req - Vercel serverless function request object
 * @returns Attempted parsed body (possibly an error)
 */
export function cleanBody<T>(req: VercelRequest): T {
	try {
		return JSON.parse(req.body) as T;
	} catch (err) {
		throw new InvalidJSONError('Malformed JSON');
	}
}

/**
 * Fetches the nextId value from the database
 * @returns The nextId value from the database
 */
export async function getNextId(): Promise<number> {
	if (!db) throw new DBInitError();
	const idObj = (await db.get('nextId')) as _IDObj;
	return idObj?.id ?? null;
}

/**
 * Increments or resets the nextId value in the database
 * @param base - If provided, nextId will be reset to this value;
 * if not provided, existing value will be incremented
 * @returns The value nextId is set to
 */
export async function incNextId(base?: number): Promise<number> {
	if (!db) throw new DBInitError();
	// Add nextId to db if doesn't already exist
	if (!(await getNextId())) {
		await db.put({ id: 1 }, 'nextId');
		return 1;
	}

	const updates = {
		id: base ?? db.util.increment(),
	};

	await db.update(updates, 'nextId');
	const id = await getNextId();
	return id;
}

export const arrayHasIndex = (array: any[], index: number) =>
	Array.isArray(array) && Array.prototype.hasOwnProperty.call(array, index);

export function hasAllChallongeIds(poll: Poll): boolean {
	const objHasId = Object.prototype.hasOwnProperty.call(poll, 'challongeId');
	const entriesHaveId = poll.entries.every(e =>
		Object.prototype.hasOwnProperty.call(e, 'challongeId')
	);
	return objHasId && entriesHaveId;
}

export function isVote(vote: unknown): vote is Vote {
	const keys = ['id', 'choice'];
	return vote ? keys.every(key => Object.prototype.hasOwnProperty.call(vote, key)) : false;
}

export function isPoll(poll: unknown): poll is Poll {
	if ((poll as Poll).entries == null) return false;

	const keys = ['id', 'entries'];
	const entryKeys = ['name', 'votes'];

	const isShallowPoll = keys.every(key => Object.prototype.hasOwnProperty.call(poll, key));
	const isDeepPoll = (poll as Poll).entries.every(e =>
		entryKeys.every(key => Object.prototype.hasOwnProperty.call(e, key))
	);

	return isShallowPoll && isDeepPoll;
}
