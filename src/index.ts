import "./env";
import express, { Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createConnection, getRepository } from "typeorm";
import { NFT } from "./shared/entities/NFT";
import connectionOptions from "./shared/ormconfig";
import ffmpeg from "fluent-ffmpeg";
import Bottleneck from "bottleneck";
import { HttpsProxyAgent } from "https-proxy-agent";
import svg2png from "svg2png";

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = IS_PRODUCTION ? process.env.PORT : 9000;

const app = express();
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    credentials: true,
  })
);

const proxyUrls = [
  "http://3.36.128.152:3128",
  "http://43.201.115.129:3128",
  "http://13.125.246.212:3128",
  "http://13.124.178.240:3128",
  "http://13.125.146.26:3128",
  "http://43.202.62.251:3128",
  "", // 프록시 없음
];

let proxyIndex = 0;

const getProxyAgent = () => {
  const proxyUrl = proxyUrls[proxyIndex];
  proxyIndex = (proxyIndex + 1) % proxyUrls.length; // 다음 프록시를 선택
  if (proxyUrl === "") {
    return undefined; // 프록시 없음
  }
  return new HttpsProxyAgent(proxyUrl);
};

const axiosInstance = axios.create();

const encrypt = (tokenId: string | number) => {
  const cipher = crypto.createCipher(
    "aes-256-cbc",
    process.env.SECRET as string
  );
  let encrypted = cipher.update(String(tokenId), "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
};

const decrypt = (encrypted: string) => {
  const decipher = crypto.createDecipher(
    "aes-256-cbc",
    process.env.SECRET as string
  );
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

// 서버 주소를 키로 하고, 해당 서버의 Bottleneck 인스턴스를 값으로 하는 Map을 생성합니다.
const limiters = new Map<string, Bottleneck>();

const getLimiterForServer = (server: string) => {
  if (!limiters.has(server)) {
    const limiter = new Bottleneck({
      minTime: 200, // 1초에 3개까지 요청
    });
    limiters.set(server, limiter);
  }
  return limiters.get(server)!;
};

const downloadImage = async ({
  nftId,
  imageUrl,
  contractAddress,
  tokenId,
  format,
}: {
  nftId: number;
  imageUrl?: string;
  contractAddress: string;
  tokenId?: string | number;
  format?: string;
}) => {
  const nftRepository = getRepository(NFT);
  const nft = await nftRepository.findOne({
    where: { id: nftId },
  });

  if (!nft || !imageUrl || !tokenId || !contractAddress) {
    let failedMessage = "";
    if (!nft) failedMessage = "nft가 없습니다.";
    if (!imageUrl) failedMessage = "imageUrl가 없습니다.";
    if (!tokenId) failedMessage = "tokenId가 없습니다.";
    if (!contractAddress) failedMessage = "contractAddress가 없습니다.";
    await nftRepository.update(
      { id: nftId },
      { isImageUploaded: false, imageSaveError: failedMessage }
    );
    return;
  }
  try {
    let imageData;
    if (imageUrl.startsWith("data:image/svg+xml;base64,")) {
      const base64Data = imageUrl.replace(/^data:image\/svg\+xml;base64,/, "");
      imageData = Buffer.from(base64Data, "base64");
    } else {
      if (!imageUrl) {
        if (nft) {
          await nftRepository.update(
            { id: nftId },
            {
              isImageUploaded: false,
              imageSaveError: "imageUrl이 제공되지 않았습니다.",
            }
          );
        }
        return;
      }

      let server = "";
      if (imageUrl.startsWith("ipfs://")) {
        let ipfsHash = imageUrl.split("ipfs://")[1];
        if (ipfsHash.startsWith("ipfs/")) {
          ipfsHash = ipfsHash.split("ipfs/")[1];
        }
        imageUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
        server = "ipfs.io";
      } else if (imageUrl.startsWith("ar://")) {
        const arweaveHash = imageUrl.split("ar://")[1];
        imageUrl = `https://arweave.net/${arweaveHash}`;
        server = "arweave.net";
      } else {
        server = imageUrl.split("/")[2];
      }

      const limiter = getLimiterForServer(server);
      try {
        const response = await limiter.schedule(
          async () =>
            await axiosInstance.get(imageUrl as string, {
              responseType: "arraybuffer",
              maxContentLength: 5 * 1024 * 1024 * 1024, // 3GB
              httpsAgent: getProxyAgent(),
            })
        );
        imageData = response.data;
      } catch (error: any) {
        if (error.response && error.response.status === 429) {
          const retryAfter = error.response.headers["retry-after"];
          console.log(
            `429 error occurred. Retry after 1 minute. Server: ${server}, ${imageUrl}: retryAfter: ${retryAfter}`
          );
        }
        throw error;
      }
    }
    let baseDirectory = __dirname;

    if (IS_PRODUCTION) {
      baseDirectory = path.join(
        __dirname,
        "..",
        "..",
        "www",
        "html",
        "images",
        contractAddress
      );
    }

    const IMAGE_FORMAT_LIST = [
      "gif",
      "jpeg",
      "jpg",
      "mp4",
      "png",
      "svg+xml",
      "tiff",
      "webp",
    ];

    if (format && !IMAGE_FORMAT_LIST?.includes(format)) {
      format = undefined;
    }

    if (!format && imageUrl) {
      const ext = path.extname(imageUrl).toLowerCase();
      format = ext.replace(".", "");
    }

    if (!format) {
      (async () => {
        const { fileTypeFromFile } = await (eval(
          'import("file-type")'
        ) as Promise<typeof import("file-type")>);

        await fileTypeFromFile(imageData).then((fileType) => {
          if (fileType) {
            format = fileType.ext;
          }
        });
      })();
    }

    if (!format) {
      format = "png";
    }

    let hashedFileName;
    if (format === "svg+xml") {
      hashedFileName = encrypt(tokenId) + ".png";
    } else if ("mp4") {
      hashedFileName = encrypt(tokenId) + ".gif";
    } else {
      hashedFileName = encrypt(tokenId) + `.${format}`;
    }
    const thumbnailPath = path.join(baseDirectory, "thumbnail");

    // No special case for mp4 anymore
    if (!fs.existsSync(thumbnailPath)) {
      fs.mkdirSync(thumbnailPath, { recursive: true });
    }

    if (["jpeg", "jpg", "png", "webp", "tiff"].includes(format)) {
      // For image formats that Sharp can handle, we resize and change format
      const transformer = sharp(imageData)
        .resize(200)
        .toFormat(format as any);
      await transformer.toFile(path.join(thumbnailPath, hashedFileName));
    } else if (format === "svg+xml") {
      // SVG를 PNG로 변환
      const pngImage = await svg2png(imageData, {
        width: 512,
        height: 512,
      });
      fs.writeFileSync(path.join(thumbnailPath, hashedFileName), pngImage);
    } else if (format === "gif") {
      const tempFilePath = path.join(
        thumbnailPath,
        `${encrypt(tokenId)}_temp.gif`
      );
      fs.writeFileSync(tempFilePath, imageData);

      const outputPath = path.join(thumbnailPath, hashedFileName);

      await new Promise((resolve, reject) => {
        ffmpeg(tempFilePath)
          .outputOptions("-vf scale=200:-1") // Resize the GIF
          .output(outputPath)
          .on("end", () => {
            fs.unlinkSync(tempFilePath); // Delete the original, unprocessed GIF file
            resolve(undefined);
          })
          .on("error", reject)
          .run(); // Run the command
      });
    } else if (format === "mp4") {
      const tempFilePath = path.join(
        thumbnailPath,
        `${encrypt(tokenId)}_temp.mp4`
      );
      fs.writeFileSync(tempFilePath, imageData);

      const outputPath = path.join(thumbnailPath, `${hashedFileName}`);

      await new Promise((resolve, reject) => {
        ffmpeg(tempFilePath)
          .outputOptions("-vf", "scale=320:-1") // scale filter for resizing, you can adjust as needed
          .outputOptions("-r 10") // Set frame rate (Hz value, fraction or abbreviation), adjust as needed
          .toFormat("gif")
          .output(outputPath)
          .on("end", () => {
            fs.unlinkSync(tempFilePath); // Delete the original, unprocessed video file
            resolve(undefined);
          })
          .on("error", reject)
          .run(); // Run the command
      });
    } else {
      fs.writeFileSync(path.join(thumbnailPath, hashedFileName), imageData);
    }

    if (nft) {
      nft.imageRoute = hashedFileName;
      nft.isImageUploaded = true;
      await nftRepository.update({ id: nftId }, nft);
    }
    console.log("파일을 다운로드하고 저장했습니다.");
  } catch (error: any) {
    if (nft)
      await nftRepository.update(
        { id: nftId },
        { isImageUploaded: false, imageSaveError: error.message }
      );
  }
};

app.post("/image", async (req: Request, res: Response) => {
  const {
    body: { nftId, imageUrl, contractAddress, tokenId, format },
  }: any = req;
  try {
    // 이미지 생성
    await downloadImage({ nftId, imageUrl, contractAddress, tokenId, format });
    return res.status(200).json(true);
  } catch (e: any) {
    console.log(e.message);
    return res.status(400).json(false);
  }
});

createConnection(connectionOptions)
  .then(() => {
    console.log("DB CONNECTION!");
    app.listen(PORT, async () => {
      console.log(`Listening on port: "http://localhost:${PORT}"`);
    });
  })
  .catch((error) => {
    console.log(error);
  });
