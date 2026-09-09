import { Config } from '@remotion/cli/config';

Config.overrideWebpackConfig((webpackConfig) => ({
  ...webpackConfig,
  resolve: {
    ...webpackConfig.resolve,
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
}));
