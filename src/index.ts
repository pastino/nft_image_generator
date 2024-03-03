// import "./env";
// import "reflect-metadata";
// import express, { Request, Response } from "express";
// import cors from "cors";
// import morgan from "morgan";
// import { createConnection, getRepository } from "typeorm";
// import connectionOptions from "./shared/ormconfig";
// import { handleBlockEvent } from "./shared/blockEventHandler";
// import { NFT } from "./shared/entities/NFT";
// import { downloadImage } from "./shared/downloadNFTImage";

// export const IS_PRODUCTION = process.env.NODE_ENV === "production";
// const PORT = IS_PRODUCTION ? process.env.PORT : 9001;

// const app = express();
// app.use(morgan("dev"));
// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));
// app.use(
//   cors({
//     origin: true,
//     methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
//     credentials: true,
//   })
// );

// app.post("/createBlock", async (req: Request, res: Response) => {
//   const {
//     query: { blockNumber },
//   }: any = req;

//   try {
//     const result = await handleBlockEvent(Number(blockNumber));
//     return res.status(200).json(result);
//   } catch (e: any) {
//     return res.status(400).json({ isSuccess: false, error: "실패" });
//   }
// });

// async function processNFTs() {
//   const batchSize = 500; // 한 번에 처리할 NFT의 수
//   let offset = 0; // 오프셋 초기화

//   while (true) {
//     // 조건에 맞는 NFT를 조회합니다.
//     const nfts = await getRepository(NFT)
//       .createQueryBuilder("nft")
//       .leftJoinAndSelect("nft.contract", "contract")
//       .where("nft.imageSaveError IS NOT NULL")
//       .andWhere("nft.imageRoute IS NULL")
//       .andWhere("nft.imageSaveError NOT IN (:...excludedErrors)", {
//         excludedErrors: [
//           "Request failed with status code 400",
//           "Request failed with status code 401",
//           "Request failed with status code 403",
//           "Request failed with status code 404",
//           "Request failed with status code 410",
//           "Request failed with status code 422",
//           "Request failed with status code 451",
//           "Request failed with status code 500",
//           "Request failed with status code 502",
//           "Request failed with status code 503",
//           "Request failed with status code 504",
//           "Request failed with status code 524",
//           "Request failed with status code 526",
//           "Request failed with status code 530",
//           "이미지 url이 없습니다.",
//         ],
//       })
//       .take(batchSize)
//       .skip(offset)
//       .getMany();

//     // 조회된 NFT가 없으면 처리를 중단합니다.
//     if (nfts.length === 0) {
//       console.log("조회된 NFT가 없습니다.");
//       break;
//     }

//     // 각 NFT에 대해 처리합니다.
//     for (const nft of nfts) {
//       // 여기에서 downloadImage 함수를 호출하고 결과에 따라 처리합니다.
//       const { isSuccess, message, hashedFileName } = await downloadImage({
//         imageUrl:
//           typeof nft.imageRaw === "string"
//             ? nft.imageRaw.replace(/\x00/g, "")
//             : "",
//         contractAddress: nft.contract?.address,
//         tokenId: nft.tokenId,
//       });

//       if (!isSuccess) {
//         await getRepository(NFT).update(
//           { id: nft?.id },
//           { isImageUploaded: false, imageSaveError: message }
//         );
//         continue;
//       }

//       await getRepository(NFT).update(
//         { id: nft?.id },
//         {
//           imageRoute: hashedFileName,
//           isImageUploaded: true,
//           imageSaveError: "",
//         }
//       );
//       console.log(`${nft.id} 이미지 에러 처리완료`);
//     }

//     // 다음 배치를 위해 오프셋을 업데이트합니다.
//     offset += batchSize;
//   }
// }

// createConnection(connectionOptions)
//   .then(() => {
//     console.log("DB CONNECTION!");
//     app.listen(PORT, async () => {
//       console.log(`Listening on port: "http://localhost:${PORT}"`);
//     });
//   })
//   .catch((error) => {
//     console.error("DB Connection Error:", error.message);
//   });

import "./env";
import "reflect-metadata";
import express from "express";
import { createConnection, getRepository } from "typeorm";
import connectionOptions from "./shared/ormconfig";
import * as amqp from "amqplib";
import cluster from "cluster";
import { NFT as NFTEntity } from "./shared/entities/NFT";
import { downloadImage } from "./shared/downloadNFTImage";

import { Alchemy, Network } from "alchemy-sdk";
import { getNFTDetails, sanitizeText, truncateTitle } from "./shared/utils";
import { NFT } from "./shared/modules/nft";

const apiKeys = [
  process.env.ALCHEMY_API_KEY,
  process.env.ALCHEMY_API_KEY_2,
  process.env.ALCHEMY_API_KEY_3,
  process.env.ALCHEMY_API_KEY_4,
  process.env.ALCHEMY_API_KEY_5,
  process.env.ALCHEMY_API_KEY_6,
];

interface WorkerApiKeys {
  [workerId: number]: string;
}

// 워커 ID와 API 키를 매핑
const workerApiKeys: WorkerApiKeys = {};

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = IS_PRODUCTION ? process.env.PORT : 9001;
const app = express();
app.use(express.json());

let currentNFTId = 6432573;
const numCPUs = 40;

let connection: amqp.Connection;
let channel: amqp.Channel;

const sendNextBlockNumber = async (workerId: number) => {
  const queueName = `imageWorkerQueue_${workerId}`;
  await assertQueue(queueName);
  await channel.sendToQueue(queueName, Buffer.from(currentNFTId.toString()));
  currentNFTId++;
};

const assertQueue = async (queueName: string) => {
  await channel.assertQueue(queueName, { durable: false });
};

const setupWorkerQueues = async () => {
  for (let i = 0; i < numCPUs; i++) {
    const queueName = `imageWorkerQueue_${i}`;

    // 기존 큐 삭제
    try {
      await channel.deleteQueue(queueName);
      console.log(`Queue ${queueName} deleted`);
    } catch (error: any) {
      console.error(`Error deleting queue ${queueName}:`, error.message);
    }

    // 큐 생성
    await assertQueue(queueName);
  }
};

if (cluster.isMaster) {
  createConnection(connectionOptions)
    .then(async () => {
      console.log("DB CONNECTION!");
      app.listen(PORT, async () => {
        console.log(`Listening on port: "http://localhost:${PORT}"`);
      });

      connection = await amqp.connect("amqp://guest:guest@localhost");

      channel = await connection.createChannel();

      await setupWorkerQueues();

      for (let i = 0; i < numCPUs; i++) {
        sendNextBlockNumber(i);
      }

      cluster.on("exit", (worker, code, signal) => {
        console.log(`Worker ${worker.id} died. Restarting...`);
        // 새로운 워커 생성하고 API 키 재할당
        const newWorker = cluster.fork({
          ALCHEMY_API_KEY: workerApiKeys[worker.id],
        });
        // 새 워커에 대한 API 키 업데이트
        workerApiKeys[newWorker.id] = workerApiKeys[worker.id];
        // 기존 워커 삭제
        delete workerApiKeys[worker.id];

        // 새로운 워커에게 다음 블록 번호 전송
        sendNextBlockNumber(newWorker.id);
      });

      cluster.on("message", (worker, message, handle) => {
        if (message && message.done) {
          const workerId = worker.id;
          sendNextBlockNumber(workerId);
        }
      });
    })
    .catch((error) => {
      console.error("DB Connection Error:", error.message);
    });

  const startInitial = async () => {
    for (let i = 0; i < numCPUs; i++) {
      const worker = cluster.fork({
        ALCHEMY_API_KEY: apiKeys[i % apiKeys.length],
      });

      // 워커 ID와 API 키를 매핑
      workerApiKeys[worker.id] = apiKeys[i % apiKeys.length] as string;
    }
  };

  startInitial();
} else {
  (async () => {
    await createConnection(connectionOptions);
    console.log("DB CONNECTION IN WORKER!");

    connection = await amqp.connect("amqp://guest:guest@localhost");
    channel = await connection.createChannel();

    const workerId: any = cluster.worker ? cluster.worker.id : null;

    const queueName = `imageWorkerQueue_${workerId}`;

    await assertQueue(queueName);

    channel.consume(queueName, async (msg) => {
      if (msg) {
        const nftId = parseInt(msg.content.toString(), 10);
        console.log(`${nftId} 이미지 처리 시작`);
        try {
          const nft = await getRepository(NFTEntity).findOne({
            where: {
              id: nftId,
            },
            relations: ["contract"],
          });
          const config = {
            apiKey: workerApiKeys[workerId] || process.env.ALCHEMY_API_KEY,
            network: Network.ETH_MAINNET,
          };

          const alchemy = new Alchemy(config);

          if (nft?.imageRoute) {
            if (!nft?.isUpdatedComplete) {
              const { isSuccess, nftDetail, message } = await getNFTDetails(
                nft.contract.address,
                nft.tokenId,
                alchemy
              );

              const updateData: any = {};
              if (nftDetail?.title)
                updateData.title = truncateTitle(
                  sanitizeText(nftDetail?.title)
                );
              if (nftDetail && "description" in nftDetail) {
                updateData.description = sanitizeText(nftDetail.description);
              }
              if (nftDetail?.imageUri)
                updateData.imageRaw = sanitizeText(nftDetail?.imageUri);
              if (nftDetail?.attributesRaw)
                updateData.attributesRaw = sanitizeText(
                  nftDetail?.attributesRaw
                );
              if (nftDetail?.imageAlchemyUrl)
                updateData.imageAlchemyUrl = nftDetail?.imageAlchemyUrl;
              if (nftDetail?.tokenType)
                updateData.tokenType = nftDetail?.tokenType;
              if (nftDetail?.processingStatus)
                updateData.processingStatus = nftDetail?.processingStatus;

              if (isSuccess) {
                await getRepository(NFTEntity).update(
                  { id: nft?.id },
                  updateData
                );

                const nftModule = new NFT({
                  contract: nft.contract,
                  tokenId: nft.tokenId,
                  alchemy,
                });

                await nftModule.saveAttributes(
                  nft,
                  nft.contract,
                  nftDetail?.attribute
                );

                await getRepository(NFTEntity).update(
                  { id: nft?.id },
                  {
                    isUpdatedComplete: true,
                    errorMessage: "",
                  }
                );
              } else {
                await getRepository(NFTEntity).update(
                  { id: nft?.id },
                  {
                    ...updateData,
                    errorMessage: message,
                    processingStatus: 1,
                  }
                );
              }
            }
            await getRepository(NFTEntity).update(
              {
                id: nftId,
              },
              {
                processingStatus: 4,
              }
            );
            return;
          }

          if (!nft || (!nft?.imageRaw && !nft?.imageAlchemyUrl)) {
            return;
          }

          if (
            nft?.processingStatus > 1 &&
            (nft?.imageRaw || nft?.imageAlchemyUrl)
          ) {
            const imageUrl = nft?.imageRaw
              ? nft?.imageRaw.replace(/\x00/g, "")
              : nft?.imageAlchemyUrl;

            try {
              const { isSuccess, message, hashedFileName } =
                await downloadImage({
                  imageUrl,
                  contractAddress: nft.contract.address,
                  tokenId: nft.tokenId,
                });

              if (isSuccess) {
                await getRepository(NFTEntity).update(
                  {
                    id: nftId,
                  },
                  {
                    imageRoute: hashedFileName,
                    processingStatus: 4,
                    errorMessageForImage: "",
                  }
                );
              } else {
                await getRepository(NFTEntity).update(
                  {
                    id: nftId,
                  },
                  {
                    errorMessageForImage: message,
                  }
                );
              }
            } catch (e: any) {
              await getRepository(NFTEntity).update(
                {
                  id: nftId,
                },
                {
                  errorMessageForImage: e.message,
                }
              );
            }
          }
        } catch (e: any) {
          console.log(e);
          // 오류 로깅 또는 복구 로직을 여기에 추가
        } finally {
          console.log(`${nftId} 이미지 처리 완료`);
          channel.ack(msg); // 성공이든 실패든 메시지를 큐에서 제거
          if (process.send) {
            process.send({ done: true });
          }
        }
      }
    });
  })().catch(console.error);
}

// import "./env";
// import "reflect-metadata";
// import express, { Request, Response } from "express";
// import cors from "cors";
// import morgan from "morgan";
// import { createConnection, getRepository } from "typeorm";
// import connectionOptions from "./shared/ormconfig";
// import { handleBlockEvent } from "./shared/blockEventHandler";
// import { NFT } from "./shared/entities/NFT";
// import { downloadImage } from "./shared/downloadNFTImage";

// export const IS_PRODUCTION = process.env.NODE_ENV === "production";
// const PORT = IS_PRODUCTION ? process.env.PORT : 9001;

// const app = express();
// app.use(morgan("dev"));
// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));
// app.use(
//   cors({
//     origin: true,
//     methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
//     credentials: true,
//   })
// );

// app.post("/createBlock", async (req: Request, res: Response) => {
//   const {
//     query: { blockNumber },
//   }: any = req;

//   try {
//     const result = await handleBlockEvent(Number(blockNumber));
//     return res.status(200).json(result);
//   } catch (e: any) {
//     return res.status(400).json({ isSuccess: false, error: "실패" });
//   }
// });

// async function processNFTs() {
//   const batchSize = 500; // 한 번에 처리할 NFT의 수
//   let offset = 0; // 오프셋 초기화

//   while (true) {
//     // 조건에 맞는 NFT를 조회합니다.
//     const nfts = await getRepository(NFT)
//       .createQueryBuilder("nft")
//       .leftJoinAndSelect("nft.contract", "contract")
//       .where("nft.imageSaveError IS NOT NULL")
//       .andWhere("nft.imageRoute IS NULL")
//       .andWhere("nft.imageSaveError NOT IN (:...excludedErrors)", {
//         excludedErrors: [
//           "Request failed with status code 400",
//           "Request failed with status code 401",
//           "Request failed with status code 403",
//           "Request failed with status code 404",
//           "Request failed with status code 410",
//           "Request failed with status code 422",
//           "Request failed with status code 451",
//           "Request failed with status code 500",
//           "Request failed with status code 502",
//           "Request failed with status code 503",
//           "Request failed with status code 504",
//           "Request failed with status code 524",
//           "Request failed with status code 526",
//           "Request failed with status code 530",
//           "이미지 url이 없습니다.",
//         ],
//       })
//       .take(batchSize)
//       .skip(offset)
//       .getMany();

//     // 조회된 NFT가 없으면 처리를 중단합니다.
//     if (nfts.length === 0) {
//       console.log("조회된 NFT가 없습니다.");
//       break;
//     }

//     // 각 NFT에 대해 처리합니다.
//     for (const nft of nfts) {
//       // 여기에서 downloadImage 함수를 호출하고 결과에 따라 처리합니다.
//       const { isSuccess, message, hashedFileName } = await downloadImage({
//         imageUrl:
//           typeof nft.imageRaw === "string"
//             ? nft.imageRaw.replace(/\x00/g, "")
//             : "",
//         contractAddress: nft.contract?.address,
//         tokenId: nft.tokenId,
//       });

//       if (!isSuccess) {
//         await getRepository(NFT).update(
//           { id: nft?.id },
//           { isImageUploaded: false, imageSaveError: message }
//         );
//         continue;
//       }

//       await getRepository(NFT).update(
//         { id: nft?.id },
//         {
//           imageRoute: hashedFileName,
//           isImageUploaded: true,
//           imageSaveError: "",
//         }
//       );
//       console.log(`${nft.id} 이미지 에러 처리완료`);
//     }

//     // 다음 배치를 위해 오프셋을 업데이트합니다.
//     offset += batchSize;
//   }
// }

// createConnection(connectionOptions)
//   .then(() => {
//     console.log("DB CONNECTION!");
//     app.listen(PORT, async () => {
//       console.log(`Listening on port: "http://localhost:${PORT}"`);

//       await processNFTs();
//       console.log("NFT 처리 완료");
//     });
//   })
//   .catch((error) => {
//     console.error("DB Connection Error:", error.message);
//   });
