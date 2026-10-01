import { Body, Controller, Get, Module, Post, UnauthorizedException, ValidationPipe, type Type as NestType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, IsUrl, Length, Matches, Max,
  MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VALIDATION_MESSAGES } from '../src/errors/validation-messages.js';
import { JsonLogger, KitExceptionFilter, catalogProblems, requestContextMiddleware } from '../src/index.js';
import { createTestApp, type TestApp } from './support/app.js';

/**
 * ADR-0054 D4 / D5 / D10 (Core V1 refactor R4): class-validator failures keep `message: string[]` (same elements, same order, English
 * byte-identical to Nest's), gain `code: 'validation_error'`, and each element is rendered in en / fr / ar.
 */
class Address {
  @IsString() street!: string;
  @IsInt() @Min(1) number!: number;
}

class EverythingDto {
  @IsString() name!: string;
  @IsInt() @Min(1) @Max(10) count!: number;
  @IsBoolean() flag!: boolean;
  @IsObject() meta!: object;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(2) @IsIn(['image/png', 'image/jpeg'], { each: true }) types!: string[];
  @IsUUID() id!: string;
  @IsUrl() url!: string;
  @IsEmail() email!: string;
  @IsIn(['card', 'cash']) method!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @MinLength(8) secret!: string;
  @MaxLength(4) code!: string;
  @Length(2, 5) between!: string;
  @ValidateNested() @Type(() => Address) address!: Address;
  @IsOptional() @IsString({ message: 'nickname is a custom message' }) nickname?: string;
}

class LengthDto {
  @Length(3, 5) word!: string;
}

@Controller('v')
class ValidationController {
  @Post('everything') everything(@Body() _dto: EverythingDto) {
    return { ok: true };
  }
  @Post('length') length(@Body() _dto: LengthDto) {
    return { ok: true };
  }
  @Get('bare-401') bare401() {
    throw new UnauthorizedException();
  }
}
@Module({ controllers: [ValidationController as NestType<unknown>] })
class ValidationModule {}

// Fake values only: what a client might send in a field; it must never come back in a validation message.
const SENTINELS = ['password=DO_NOT_LEAK', 'Bearer FAKE_SECRET', 'db.internal.example', '/srv/private/validation-secret'];
const BAD = {
  name: 42, count: 'password=DO_NOT_LEAK', flag: 'Bearer FAKE_SECRET', meta: 'db.internal.example', types: ['image/gif', 'x', 'y'],
  id: '/srv/private/validation-secret', url: 'not a url', email: 'nope', method: 'gold', currency: 'eur', secret: 'short', code: 'toolong',
  between: 'x', address: { street: 7, number: 0 }, nickname: 9, extra: 'password=DO_NOT_LEAK',
};

let t: TestApp;
let stock: NestExpressApplication;
beforeAll(async () => {
  t = await createTestApp({ extraImports: [ValidationModule] });
  // the reference: Nest's own ValidationPipe with the same options, rendered by the pre-localization filter
  const moduleRef = await Test.createTestingModule({ imports: [ValidationModule] }).compile();
  stock = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  stock.use(requestContextMiddleware);
  stock.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: false }));
  stock.useGlobalFilters(new KitExceptionFilter(new JsonLogger('stock', 'error', () => undefined)));
  await stock.listen(0, '127.0.0.1');
});
afterAll(async () => {
  await t.app.close();
  await stock.close();
});
const post = (app: NestExpressApplication, path: string, body: unknown, lang?: string) => {
  const r = request(app.getHttpServer()).post(path).send(body as object);
  return lang === undefined ? r : r.set('accept-language', lang);
};

describe('English compatibility (D6)', () => {
  it('with no Accept-Language the message array is byte-identical to Nest\'s own ValidationPipe, element for element', async () => {
    const before = (await post(stock, '/v/everything', BAD).expect(400)).body.message as string[];
    const after = await post(t.app, '/v/everything', BAD).expect(400);
    expect(after.body.message).toEqual(before);
    expect(before.length).toBeGreaterThanOrEqual(18); // the payload really exercises every validator
    for (const lang of ['en', 'en-US', 'de', ';;q=x']) expect((await post(t.app, '/v/everything', BAD, lang)).body.message).toEqual(before);
  });

  it.each([['a'], ['abcdefg'], [5]])('@Length chooses the same English message as class-validator (%j)', async (word) => {
    const before = (await post(stock, '/v/length', { word }).expect(400)).body.message;
    expect((await post(t.app, '/v/length', { word }).expect(400)).body.message).toEqual(before);
  });
});

describe('localized messages (D5)', () => {
  it('renders each element in fr and ar: same string[], same length, same order, one-to-one', async () => {
    const en = (await post(t.app, '/v/everything', BAD, 'en').expect(400)).body.message as string[];
    const fr = (await post(t.app, '/v/everything', BAD, 'fr').expect(400)).body.message as string[];
    const ar = (await post(t.app, '/v/everything', BAD, 'ar').expect(400)).body.message as string[];
    for (const m of [fr, ar]) {
      expect(Array.isArray(m)).toBe(true);
      expect(m).toHaveLength(en.length);
    }
    // order: the i-th element of every language is about the same property and constraint
    const pairs: [string, string, string][] = [
      ['name must be a string', 'name doit être une chaîne de caractères', 'يجب أن يكون name سلسلة نصية'],
      ['count must not be greater than 10', 'count ne doit pas être supérieur à 10', 'يجب ألا يزيد count عن 10'],
      ['count must not be less than 1', 'count ne doit pas être inférieur à 1', 'يجب ألا يقل count عن 1'],
      ['count must be an integer number', 'count doit être un nombre entier', 'يجب أن يكون count عددًا صحيحًا'],
      ['flag must be a boolean value', 'flag doit être une valeur booléenne', 'يجب أن يكون flag قيمة منطقية'],
      ['types must contain no more than 2 elements', 'types doit contenir au plus 2 éléments', 'يجب ألا يحتوي types على أكثر من 2 عناصر'],
      ['each value in types must be one of the following values: image/png, image/jpeg', "chaque valeur de types doit être l'une des valeurs suivantes : image/png, image/jpeg", 'يجب أن يكون كل قيمة في types إحدى القيم التالية: image/png, image/jpeg'],
      ['id must be a UUID', 'id doit être un UUID', 'يجب أن يكون id معرّفًا من نوع UUID'],
      ['method must be one of the following values: card, cash', "method doit être l'une des valeurs suivantes : card, cash", 'يجب أن يكون method إحدى القيم التالية: card, cash'],
      ['currency must match /^[A-Z]{3}$/ regular expression', "currency doit correspondre à l'expression régulière /^[A-Z]{3}$/", 'يجب أن يطابق currency التعبير النمطي /^[A-Z]{3}$/'],
      ['secret must be longer than or equal to 8 characters', 'secret doit contenir au moins 8 caractères', 'يجب ألا يقل طول secret عن 8 حرفًا'],
      ['code must be shorter than or equal to 4 characters', 'code doit contenir au plus 4 caractères', 'يجب ألا يزيد طول code عن 4 حرفًا'],
      ['between must be longer than or equal to 2 characters', 'between doit contenir au moins 2 caractères', 'يجب ألا يقل طول between عن 2 حرفًا'],
      ['address.street must be a string', 'address.street doit être une chaîne de caractères', 'يجب أن يكون address.street سلسلة نصية'],
      ['address.number must not be less than 1', 'address.number ne doit pas être inférieur à 1', 'يجب ألا يقل address.number عن 1'],
      ['property extra should not exist', 'la propriété extra ne doit pas être présente', 'يجب ألا تكون الخاصية extra موجودة'],
    ];
    for (const [e, f, a] of pairs) {
      const i = en.indexOf(e);
      expect(i, e).toBeGreaterThanOrEqual(0);
      expect(fr[i]).toBe(f);
      expect(ar[i]).toBe(a);
    }
  });

  it('keeps a custom message (not a class-validator default) in English, and says so in Content-Language', async () => {
    const r = await post(t.app, '/v/everything', BAD, 'fr').expect(400);
    expect(r.body.message).toContain('nickname is a custom message');
    expect(r.headers['content-language']).toBe('fr, en');
    const onlyCustom = await post(t.app, '/v/everything', { ...valid(), nickname: 9 }, 'ar').expect(400);
    expect(onlyCustom.body.message).toEqual(['nickname is a custom message']);
    expect(onlyCustom.headers['content-language']).toBe('en');
  });

  it('a fully translated list reports its language; Arabic is real UTF-8', async () => {
    // @Length's three class-validator messages: too short, too long, and the range form (a value that is not a string)
    const r = await post(t.app, '/v/length', { word: 'a' }, 'ar').expect(400);
    expect(r.body.message).toEqual(['يجب ألا يقل طول word عن 3 حرفًا']);
    expect(r.headers['content-language']).toBe('ar');
    expect(r.headers.vary).toMatch(/Accept-Language/);
    expect(r.headers['content-type']).toMatch(/charset=utf-8/);
    expect((await post(t.app, '/v/length', { word: 'abcdefg' }, 'fr-FR').expect(400)).body.message).toEqual(['word doit contenir au plus 5 caractères']);
    expect((await post(t.app, '/v/length', { word: 5 }, 'fr').expect(400)).body.message).toEqual(['word doit contenir entre 3 et 5 caractères']);
    expect((await post(t.app, '/v/length', { word: 5 }, 'ar').expect(400)).body.message).toEqual(['يجب أن يكون طول word بين 3 و5 حرفًا']);
  });
});

describe('contract (D2, D4) and R3 compatibility', () => {
  it('the body keeps its shape and gains validation_error, identical across languages except message', async () => {
    const bodies = await Promise.all(['en', 'fr', 'ar'].map((l) => post(t.app, '/v/length', { word: 'a' }, l).expect(400)));
    for (const r of bodies) expect(Object.keys(r.body).sort()).toEqual(['code', 'error', 'message', 'requestId', 'statusCode']);
    for (const r of bodies) expect(r.body).toMatchObject({ statusCode: 400, error: 'Bad Request', code: 'validation_error' });
  });

  it('only validation failures gain validation_error: an ordinary code-less error stays code-less (R3 rule)', async () => {
    const r = await request(t.app.getHttpServer()).get('/v/bare-401').set('accept-language', 'fr').expect(401);
    expect(r.body).not.toHaveProperty('code');
  });

  it('a valid body is untouched: 201, no language headers', async () => {
    const r = await post(t.app, '/v/everything', valid(), 'fr').expect(201);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['content-language']).toBeUndefined();
  });
});

describe('F13 / D10: no submitted value is ever echoed', () => {
  it.each(['en', 'fr', 'ar'])('%s: sentinel values sent in fields never reach the body or headers', async (lang) => {
    const r = await post(t.app, '/v/everything', BAD, lang).set('authorization', 'Bearer FAKE_SECRET').expect(400);
    const exposed = r.text + JSON.stringify(r.headers);
    for (const s of SENTINELS) expect(exposed).not.toContain(s);
  });
});

describe('catalog (D13)', () => {
  it('every validation message has en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(VALIDATION_MESSAGES)).toEqual([]);
  });
  it('Arabic and French are real translations', () => {
    for (const texts of Object.values(VALIDATION_MESSAGES)) {
      expect(texts.ar).toMatch(/[؀-ۿ]/);
      expect(texts.fr).not.toBe(texts.en);
    }
  });
});

function valid() {
  return {
    name: 'n', count: 2, flag: true, meta: {}, types: ['image/png'], id: '6f1c2a4e-3b5d-4c7e-9f8a-1b2c3d4e5f60', url: 'https://example.com',
    email: 'a@example.com', method: 'card', currency: 'EUR', secret: 'longenough', code: 'abcd', between: 'abc', address: { street: 's', number: 1 },
  };
}
