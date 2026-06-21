import type { ComponentType } from 'react';
import type { SlipDto } from '../../../hooks/useTaxSlips';
import type { SlipFormProps } from './types';
import { T4Form } from './T4Form';
import { T5Form } from './T5Form';
import { T3Form } from './T3Form';
import { T4AForm } from './T4AForm';
import { T5008Form } from './T5008Form';
import { fmtCurrency } from '../util/format';

export const SLIP_FORMS: Record<SlipDto['slipType'], ComponentType<SlipFormProps>> = {
  T4: T4Form,
  T5: T5Form,
  T3: T3Form,
  T4A: T4AForm,
  T5008: T5008Form,
};

/** Returns a compact human-readable preview of key box values for a slip. */
export function slipPreview(slipType: SlipDto['slipType'], boxValues: Record<string, number | string>): string {
  switch (slipType) {
    case 'T4':
      return boxValues.box14 !== undefined ? `box14: ${fmtCurrency(boxValues.box14)}` : '';
    case 'T5':
      return boxValues.box13 !== undefined ? `box13: ${fmtCurrency(boxValues.box13)}` : (boxValues.box24 !== undefined ? `box24: ${fmtCurrency(boxValues.box24)}` : '');
    case 'T3':
      return boxValues.box21 !== undefined ? `box21: ${fmtCurrency(boxValues.box21)}` : '';
    case 'T4A':
      return boxValues.box016 !== undefined ? `box016: ${fmtCurrency(boxValues.box016)}` : (boxValues.box020 !== undefined ? `box020: ${fmtCurrency(boxValues.box020)}` : '');
    case 'T5008':
      return boxValues.box21 !== undefined ? `proceeds: ${fmtCurrency(boxValues.box21)}` : '';
    default:
      return '';
  }
}
