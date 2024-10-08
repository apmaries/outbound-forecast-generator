// inboundHandler.js
// Description: Module to handle inbound forecast generation and deletion

// API instances
import { wapi } from "../app.js";
import { t_wapi } from "../core/testManager.js";

// Shared state modules
import { applicationConfig } from "../core/configManager.js";
import { applicationState } from "../core/stateManager.js";

// App modules
import { NotificationHandler } from "./notificationHandler.js";

// Global variables
("use strict");
const testMode = applicationConfig.testMode;

// Function to generate the forecast
async function generateAbmForecast(buId, weekStart, description) {
  console.log("[OFG.INBOUND] Generating ABM forecast");
  const abmFcDescription = "OFG Inbound FC - " + description;

  let body = {
    "description": abmFcDescription,
    "weekCount": 1,
    "canUseForScheduling": true,
  };
  let opts = {
    "forceAsync": true,
  };

  try {
    let generateResponse =
      await wapi.postWorkforcemanagementBusinessunitWeekShorttermforecastsGenerate(
        buId,
        weekStart,
        body,
        opts
      );
    console.log(
      `[OFG.INBOUND] Inbound forecast generate status = ${generateResponse.status}`
    );
    return generateResponse;
  } catch (error) {
    console.error("[OFG.INBOUND] Inbound forecast generation failed!", error);
    throw error;
  }
}

// Function to retrieve the inbound forecast data
async function getInboundForecastData(forecastId) {
  const buId = applicationState.userInputs.businessUnit.id;
  const weekStart = applicationState.userInputs.forecastParameters.weekStart;

  console.log("[OFG.INBOUND] Getting inbound forecast data");

  try {
    const forecastData = testMode
      ? await t_wapi.getInboundShorttermforecastData()
      : await wapi.getWorkforcemanagementBusinessunitWeekShorttermforecastData(
          buId,
          weekStart,
          forecastId
        );
    console.log(
      "[OFG.INBOUND] Inbound forecast data retrieved. Trimming to 7 days only",
      forecastData
    );

    // Trim results to 7 days only (8th day will be re-added later after modifications)
    forecastData.result.planningGroups.forEach((pg) => {
      pg.offeredPerInterval = pg.offeredPerInterval.slice(0, 672);
      pg.averageHandleTimeSecondsPerInterval =
        pg.averageHandleTimeSecondsPerInterval.slice(0, 672);
    });

    return forecastData;
  } catch (error) {
    console.error(
      "[OFG.INBOUND] Inbound forecast data retrieval failed!",
      error
    );
    throw error;
  }
}

// Function to transform and load inbound forecast data
async function transformAndLoadInboundForecast(inboundFcData) {
  console.log("[OFG.INBOUND] Transforming and loading inbound forecast data");
  const weekStart = applicationState.userInputs.forecastParameters.weekStart;

  // Process each planning group in inbound forecast data
  inboundFcData.result.planningGroups.forEach((pg) => {
    // Find the planning group in applicationState.generatedForecast
    const completedFcPg =
      applicationState.forecastOutputs.generatedForecast.find(
        (pgForecast) => pgForecast.planningGroup.id === pg.planningGroupId
      );
    const isInbound = completedFcPg.metadata.forecastMode === "inbound";

    if (isInbound) {
      // Transform inbound forecast data to same schema as outbound forecast data
      let nContactsArray = [];
      let tHandleArray = [];

      for (let i = 0; i < pg.offeredPerInterval.length; i += 96) {
        let chunkOffered = pg.offeredPerInterval.slice(i, i + 96);
        let chunkAht = pg.averageHandleTimeSecondsPerInterval.slice(i, i + 96);
        let chunkTht = chunkOffered.map((val, idx) => val * chunkAht[idx]);

        nContactsArray.push(chunkOffered);
        tHandleArray.push(chunkTht);
      }

      // Get the day of the week from weekStart
      let date = new Date(weekStart);
      let dayOfWeek = date.getDay();

      // Calculate the difference between the current day of the week and Sunday
      let rotateBy = (7 - dayOfWeek) % 7;

      // Rotate the arrays
      nContactsArray = [
        ...nContactsArray.slice(rotateBy),
        ...nContactsArray.slice(0, rotateBy),
      ];
      tHandleArray = [
        ...tHandleArray.slice(rotateBy),
        ...tHandleArray.slice(0, rotateBy),
      ];

      let forecastData = {
        nContacts: nContactsArray,
        tHandle: tHandleArray,
        nHandled: nContactsArray, // Replicating nContacts for now - inbound forecast doesn't have nHandled data and need something to divide by when making modifications
      };

      completedFcPg.forecastData = forecastData;
    }
  });
}

// Handle the asynchronous forecast generation
async function handleAsyncForecastGeneration(buId) {
  console.log("[OFG.INBOUND] Handling async forecast generation");
  const topics = ["shorttermforecasts.generate"];

  return new Promise((resolve, reject) => {
    try {
      let generateNotifications = new NotificationHandler(
        topics,
        buId,
        onSubscriptionSuccess,
        handleInboundForecastNotification
      );

      generateNotifications.connect();
      generateNotifications.subscribeToNotifications();

      function onSubscriptionSuccess() {
        console.log(
          "[OFG.INBOUND] Successfully subscribed to forecast generate notifications"
        );
      }

      // Handle the inbound forecast notification
      async function handleInboundForecastNotification(notification) {
        // Check if "shorttermforecasts.generate" notification
        if (!notification.topicName.includes("shorttermforecasts.generate")) {
          return;
        }

        console.log("[OFG.INBOUND] Processing result from notification");

        let generateOperationId = applicationConfig.inbound.operationId;

        if (
          notification.eventBody &&
          notification.eventBody.operationId === generateOperationId
        ) {
          const status = notification.eventBody.status;
          console.log(`[OFG.INBOUND] Forecast status = <${status}>`);

          if (status === "Complete") {
            const forecastId = notification.eventBody.result.id;
            applicationConfig.inbound.inboundFcId = forecastId;
            const inboundForecastData = await getInboundForecastData(
              forecastId
            );
            await transformAndLoadInboundForecast(inboundForecastData);
            generateNotifications.disconnect();

            // Dispatch the custom event when the forecast generation is complete
            const event = new CustomEvent("inboundForecastComplete", {
              detail: {
                retainInbound:
                  applicationState.userInputs.forecastOptions.retainInbound,
              },
            });
            window.dispatchEvent(event);

            resolve(); // Resolve the promise when complete
          } else if (status === "Processing") {
            // Any additional logic needed?
          } else if (status === "Error") {
            console.error(
              "[OFG.INBOUND] Inbound forecast generation failed with status: ",
              notification.eventBody
            );
            generateNotifications.disconnect();
            reject(new Error("Inbound forecast generation failed"));
          } else {
            // Handle unknown status if necessary
            console.warn("[OFG.INBOUND] Received unknown status: ", status);
          }
        }
      }
    } catch (error) {
      console.error(
        "[OFG.INBOUND] Error occurred while subscribing to notifications:",
        error
      );
      reject(new Error("Inbound forecast generation failed: " + error.message));
    }
  });
}

// Primary function to generate the inbound forecast
export async function generateInboundForecast() {
  console.info("[OFG.INBOUND] Initiating inbound forecast generation");

  const buId = applicationState.userInputs.businessUnit.id;
  const { weekStart, description } =
    applicationState.userInputs.forecastParameters;

  // Return test data if in test mode
  if (testMode) {
    const inboundForecastData = await getInboundForecastData();
    console.log(
      "%c[OFG.TEST] Forecast data loaded from test data",
      "color: red",
      inboundForecastData
    );
    await transformAndLoadInboundForecast(inboundForecastData);
    applicationConfig.inbound.inboundForecastId = "abc-123";

    // Dispatch the custom event when the forecast generation is complete
    const event = new CustomEvent("inboundForecastComplete", {
      detail: {
        retainInbound:
          applicationState.userInputs.forecastOptions.retainInbound,
      },
    });
    window.dispatchEvent(event);

    return;
  }

  // Generate the forecast and immediately check its status
  const generateResponse = await generateAbmForecast(
    buId,
    weekStart,
    description
  );

  if (generateResponse.status === "Complete") {
    // Synchronous handling if the forecast is already complete
    const forecastId = generateResponse.result.id;
    applicationConfig.inbound.inboundForecastId = forecastId;
    const inboundForecastData = await getInboundForecastData(forecastId);
    await transformAndLoadInboundForecast(inboundForecastData);
    console.log(
      "[OFG.INBOUND] Inbound forecast generation complete",
      inboundForecastData
    );

    // Dispatch the custom event when the forecast generation is complete
    const event = new CustomEvent("inboundForecastComplete", {
      detail: {
        retainInbound:
          applicationState.userInputs.forecastOptions.retainInbound,
      },
    });
    window.dispatchEvent(event);

    return inboundForecastData;
  } else if (generateResponse.status === "Processing") {
    // Asynchronous handling through notifications
    let operationId = generateResponse.operationId;
    applicationConfig.inbound.operationId = operationId;

    return handleAsyncForecastGeneration(buId);
  } else {
    console.error(
      "[OFG.INBOUND] Inbound forecast generation failed with initial status: ",
      generateResponse
    );
    throw new Error("Inbound forecast generation failed");
  }
}

// Function to delete the inbound forecast
export async function deleteInboundForecast() {
  const buId = applicationState.userInputs.businessUnit.id;
  const weekStart = applicationState.userInputs.forecastParameters.weekStart;
  const forecastId = applicationConfig.inbound.inboundFcId;

  console.log(`[OFG.INBOUND] Deleting inbound forecast with id: ${forecastId}`);

  // Return if forecast ID is not set
  if (!forecastId) {
    console.warn(
      "[OFG.INBOUND] Inbound forecast ID not set. Skipping deletion"
    );
    return;
  }

  // Return if in test mode
  if (testMode) {
    return;
  }

  // Delete the forecast
  let delResponse = null;
  try {
    delResponse =
      await wapi.deleteWorkforcemanagementBusinessunitWeekShorttermforecast(
        buId,
        weekStart,
        forecastId
      );
  } catch (error) {
    console.error("[OFG.INBOUND] Inbound forecast deletion failed!", error);
    alert(
      "An error occurred while deleting the inbound forecast. Please delete manually via UI."
    );
    return;
  }

  // temp logging
  console.log(
    "[OFG.TEMP] Inbound forecast deletion response: ",
    delResponse,
    delResponse.status
  );

  // Validate response status code
  if (delResponse.status !== 204) {
    console.error(
      "[OFG.INBOUND] Inbound forecast deletion failed with status: ",
      delResponse
    );
    alert(
      "An error occurred while deleting the inbound forecast. Please delete manually via UI."
    );
    return;
  } else {
    // Reset the forecast ID
    applicationConfig.inbound.inboundForecastId = null;
    applicationConfig.inbound.operationId = null;
    console.log("[OFG.INBOUND] Inbound forecast deleted");
  }
}
