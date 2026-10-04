import { describe, expect, it } from 'vitest';
import { pinnedRequestConfig } from './pinned-config';

describe('pinnedRequestConfig', () => {
  it('disables axios proxies so HTTP(S)_PROXY cannot bypass the pinned agents', () => {
    const config = pinnedRequestConfig({ allowedPrivateHosts: [] });
    expect(config).toMatchObject({ proxy: false });
    expect(config).toHaveProperty('httpAgent');
    expect(config).toHaveProperty('httpsAgent');
  });

  it('adds nothing without a policy', () => {
    expect(pinnedRequestConfig(undefined)).toEqual({});
  });
});
