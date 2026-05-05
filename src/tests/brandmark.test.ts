// ============================================================================
// BRAND MARK — wave animation logic
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { charColor, CYCLE } from '../ui/BrandMark.js';
import { theme } from '../ui/theme.js';

const BRAND_LEN = 9; // 'Executant'
const SWEEP_TICKS = BRAND_LEN * 2;

describe('charColor', () => {
  describe('isActive=false', () => {
    test('all characters return primary regardless of tick', () => {
      for (let tick = 0; tick < CYCLE * 2; tick++) {
        for (let i = 0; i < BRAND_LEN; i++) {
          assert.equal(charColor(i, tick, false), theme.primary, `char ${i} tick ${tick}`);
        }
      }
    });
  });

  describe('isActive=true — sweep phase', () => {
    test('hotspot character returns primaryLight', () => {
      for (let charPos = 0; charPos < BRAND_LEN; charPos++) {
        const tick = charPos * 2; // each hotspot position lasts 2 ticks
        assert.equal(charColor(charPos, tick, true), theme.primaryLight, `hotspot at char ${charPos}`);
        assert.equal(charColor(charPos, tick + 1, true), theme.primaryLight, `hotspot at char ${charPos} tick+1`);
      }
    });

    test('non-hotspot characters return primary', () => {
      const tick = 0; // hotspot at char 0
      for (let i = 1; i < BRAND_LEN; i++) {
        assert.equal(charColor(i, tick, true), theme.primary, `char ${i} should be primary`);
      }
    });
  });

  describe('isActive=true — gap phase', () => {
    test('all characters return primary during gap', () => {
      for (let tick = SWEEP_TICKS; tick < CYCLE; tick++) {
        for (let i = 0; i < BRAND_LEN; i++) {
          assert.equal(charColor(i, tick, true), theme.primary, `char ${i} gap tick ${tick}`);
        }
      }
    });
  });

  test('cycle wraps correctly — tick=0 matches tick=CYCLE', () => {
    for (let i = 0; i < BRAND_LEN; i++) {
      assert.equal(charColor(i, 0, true), charColor(i, CYCLE, true), `char ${i}`);
    }
  });
});
