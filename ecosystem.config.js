module.exports = {
  apps: [
    {
      name: "block_number_distributor",
      script: "build/index.js",
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 9000,
      },
    },
  ],
};
