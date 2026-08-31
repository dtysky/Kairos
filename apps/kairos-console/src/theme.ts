import type { ThemeConfig } from 'antd';
import { theme } from 'antd';

export const kairosTheme: ThemeConfig = {
  algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
  token: {
    colorPrimary: '#c77b4b',
    colorInfo: '#c77b4b',
    colorSuccess: '#58a879',
    colorWarning: '#d5a44e',
    colorError: '#d6685f',
    colorBgBase: '#0b0d10',
    colorBgContainer: '#12161b',
    colorBgElevated: '#171c22',
    colorBorder: '#293039',
    colorBorderSecondary: '#20262d',
    colorText: '#f0ede8',
    colorTextSecondary: '#9ba4ae',
    borderRadius: 8,
    borderRadiusLG: 12,
    fontSize: 13,
    controlHeight: 34,
  },
  components: {
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Card: {
      headerBg: 'transparent',
    },
    Layout: {
      bodyBg: '#0b0d10',
      headerBg: '#0f1216',
      siderBg: '#0f1216',
    },
    Table: {
      headerBg: '#171c22',
      rowHoverBg: '#1a2027',
    },
  },
};
