const webpack = require('webpack');
const nodeExternals = require('webpack-node-externals');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = function(options) {
  return {
    ...options,
    entry: ['webpack/hot/poll?100', './src/main.ts'],
    watch: true,
    externals: [
      nodeExternals({
        whitelist: ['webpack/hot/poll?100'],
      }),
    ],
    plugins: [
      ...options.plugins, 
      new webpack.HotModuleReplacementPlugin(),
      new CopyWebpackPlugin([

        // Copy directory contents to {output}/to/directory/
        //{ from: 'from/directory', to: 'to/directory' },
        { from: 'src/static', to: 'static' },
    ])
    ],
  };
}