module.exports = {
  apps: [
    {
      name: "nft_image_generator",
      script: "build/index.js",
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 9001,
      },
    },
  ],
};
